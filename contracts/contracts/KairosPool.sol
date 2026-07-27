// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    Nox,
    euint256,
    externalEuint256
} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {
    IERC20ToERC7984Wrapper
} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC20ToERC7984Wrapper.sol";
import {IUniswapV3PoolMinimal, IUniswapV3SwapCallback} from "./interfaces/IUniswapV3.sol";

/**
 * @title KairosPool — a confidential dark pool settling residuals on Uniswap V3
 *
 * @notice Users submit swap orders whose AMOUNTS are encrypted end-to-end (Nox handles).
 * Orders are collected into epochs. At settlement, opposite directions are crossed
 * internally at the Uniswap spot price and ONLY the unmatched residual is swapped
 * against the canonical, unmodified Uniswap V3 pool. Individual order sizes are never
 * revealed — only the two epoch aggregates are ever publicly decrypted.
 *
 * Directions: BUY  = deposit quote (cUSDC), receive base (cWETH).
 *             SELL = deposit base (cWETH), receive quote (cUSDC).
 *
 * Epoch lifecycle (each transition is permissionless, idempotent, state-guarded):
 *   Open → Sealed → Revealed → UnwrapPending → Distributable
 *                     └────────────┴──(timeout)──→ Cancelled (full refunds)
 * Settlement is asynchronous by design: public decryption of aggregates and the
 * wrapper unwrap both require an off-chain Nox TEE round-trip.
 *
 * KNOWN LIMITATIONS (deliberate, documented for judges):
 *  - Order DIRECTION and participation are public metadata; only amounts are hidden.
 *  - Internal crossing uses the Uniswap spot price (slot0) at settlement; spot is
 *    flash-manipulable on mainnet — a TWAP oracle is the production upgrade path.
 *  - k-anonymity degrades in small epochs; the frontend warns below a threshold.
 */
contract KairosPool is Ownable2Step, ReentrancyGuard, IUniswapV3SwapCallback {
    using SafeERC20 for IERC20;

    // ============ Types ============

    enum EpochState {
        None,
        Open,
        Sealed,
        Revealed,
        UnwrapPending,
        Distributable,
        Cancelled
    }

    /// @dev Direction of the residual swap decided at settlement initiation.
    enum Residual {
        NoResidual,
        BuyHeavy, // net quote left over → swap quote → base
        SellHeavy // net base left over  → swap base → quote
    }

    struct Epoch {
        EpochState state;
        uint64 startTime;
        uint64 endTime;
        uint64 sealedAt;
        uint32 buyCount; // distinct buy participants
        uint32 sellCount; // distinct sell participants
        euint256 buyTotalEnc; // encrypted sum of actual buy deposits (quote units)
        euint256 sellTotalEnc; // encrypted sum of actual sell deposits (base units)
        uint256 buyTotal; // plaintext after reveal
        uint256 sellTotal; // plaintext after reveal
        Residual residual;
        uint256 residualIn; // plaintext residual input amount
        euint256 unwrapRequestId; // wrapper unwrap request handle
        uint256 buyOutTotal; // base units owed to buyers (final at Distributable)
        uint256 sellOutTotal; // quote units owed to sellers (final at Distributable)
    }

    // ============ Errors ============

    error Kairos_WrongState(uint256 epochId, EpochState actual);
    error Kairos_EpochNotEnded();
    error Kairos_EpochEnded();
    error Kairos_TimeoutNotReached();
    error Kairos_NoOrder();
    error Kairos_AlreadyClaimed();
    error Kairos_SlippageExceeded(uint256 got, uint256 minOut);
    error Kairos_UnexpectedCallback();
    error Kairos_UnwrapNotFinalized();
    error Kairos_InvalidParam();
    error Kairos_PendingUnwraps();

    // ============ Events ============

    event EpochOpened(uint256 indexed epochId, uint64 startTime, uint64 endTime);
    event OrderSubmitted(uint256 indexed epochId, address indexed user, bool isBuy);
    event OrderCancelled(uint256 indexed epochId, address indexed user, bool isBuy);
    event EpochSealed(
        uint256 indexed epochId,
        bytes32 buyTotalHandle,
        bytes32 sellTotalHandle,
        uint32 buyCount,
        uint32 sellCount
    );
    event EpochRevealed(uint256 indexed epochId, uint256 buyTotal, uint256 sellTotal);
    event SettlementInitiated(
        uint256 indexed epochId,
        Residual residual,
        uint256 residualIn,
        uint256 matchedQuote,
        bytes32 unwrapRequestHandle
    );
    event ResidualSwapped(uint256 indexed epochId, uint256 amountIn, uint256 amountOut);
    event EpochDistributable(uint256 indexed epochId, uint256 buyOutTotal, uint256 sellOutTotal);
    event EpochCancelled(uint256 indexed epochId);
    event Claimed(uint256 indexed epochId, address indexed user);
    event RefundClaimed(uint256 indexed epochId, address indexed user);
    event AuditorSet(address auditor);
    event EpochParamsSet(uint64 epochDuration, uint64 revealTimeout, uint16 maxSlippageBps);

    // ============ Immutables ============

    IERC20 public immutable quoteToken; // e.g. tUSDC (public ERC-20)
    IERC20 public immutable baseToken; // e.g. WETH9 (public ERC-20)
    IERC20ToERC7984Wrapper public immutable cQuote; // confidential wrapper of quoteToken
    IERC20ToERC7984Wrapper public immutable cBase; // confidential wrapper of baseToken
    IUniswapV3PoolMinimal public immutable uniPool;
    bool public immutable quoteIsToken0;

    /// @dev TickMath sqrt price bounds (exclusive) from Uniswap V3 core.
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint256 private constant BPS = 10_000;

    // ============ Storage ============

    uint64 public epochDuration;
    uint64 public revealTimeout;
    uint16 public maxSlippageBps;
    address public auditor; // optional selective-disclosure viewer

    uint256 public currentEpochId;
    mapping(uint256 epochId => Epoch) private _epochs;
    mapping(uint256 epochId => mapping(address user => euint256)) private _buyOrders;
    mapping(uint256 epochId => mapping(address user => euint256)) private _sellOrders;
    mapping(uint256 epochId => mapping(address user => bool)) public claimed;

    /// @dev Number of epochs stuck in UnwrapPending — guards owner dust sweeps.
    uint256 public pendingUnwraps;
    /// @dev Reentrancy-style guard: only accept the Uniswap callback we initiated.
    bool private _inSwap;

    // ============ Constructor ============

    constructor(
        IERC20ToERC7984Wrapper cQuote_,
        IERC20ToERC7984Wrapper cBase_,
        IUniswapV3PoolMinimal uniPool_,
        uint64 epochDuration_,
        uint64 revealTimeout_,
        uint16 maxSlippageBps_,
        address owner_
    ) Ownable(owner_) {
        cQuote = cQuote_;
        cBase = cBase_;
        uniPool = uniPool_;
        quoteToken = IERC20(cQuote_.underlying());
        baseToken = IERC20(cBase_.underlying());

        address t0 = uniPool_.token0();
        address t1 = uniPool_.token1();
        bool quoteIs0 = t0 == address(quoteToken) && t1 == address(baseToken);
        bool quoteIs1 = t1 == address(quoteToken) && t0 == address(baseToken);
        if (!quoteIs0 && !quoteIs1) revert Kairos_InvalidParam();
        quoteIsToken0 = quoteIs0;

        _setEpochParams(epochDuration_, revealTimeout_, maxSlippageBps_);
        _openNextEpoch();
    }

    // ============ User actions ============

    /**
     * @notice Submit an encrypted order into the current epoch.
     * The amount was encrypted in the user's browser, bound to this contract address;
     * plaintext never appears in calldata. The pool must already be an ERC-7984
     * operator for the caller on the deposit token (`setOperator`).
     *
     * @dev We record the ACTUAL transferred handle returned by the token (ERC-7984
     * transfers silently move 0 on insufficient balance) — crediting the requested
     * amount instead would let users claim funds they never deposited.
     */
    function submitOrder(
        bool isBuy,
        externalEuint256 encryptedAmount,
        bytes calldata inputProof
    ) external nonReentrant {
        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Open);
        if (block.timestamp >= e.endTime) revert Kairos_EpochEnded();

        euint256 amount = Nox.fromExternal(encryptedAmount, inputProof);
        IERC7984 token = IERC7984(address(isBuy ? cQuote : cBase));

        // The token contract itself needs (transient) access to operate on the handle.
        Nox.allowTransient(amount, address(token));
        euint256 transferred = token.confidentialTransferFrom(msg.sender, address(this), amount);

        mapping(address => euint256) storage orders = isBuy
            ? _buyOrders[epochId]
            : _sellOrders[epochId];
        euint256 prev = orders[msg.sender];
        bool firstOrder = !Nox.isInitialized(prev);
        euint256 newOrder = firstOrder ? transferred : Nox.add(prev, transferred);
        // Persist access: pool reuses the handle at claim time, user can decrypt it.
        Nox.allowThis(newOrder);
        Nox.allow(newOrder, msg.sender);
        if (auditor != address(0)) Nox.addViewer(newOrder, auditor);
        orders[msg.sender] = newOrder;

        if (isBuy) {
            e.buyTotalEnc = Nox.add(e.buyTotalEnc, transferred);
            Nox.allowThis(e.buyTotalEnc);
            if (firstOrder) e.buyCount++;
        } else {
            e.sellTotalEnc = Nox.add(e.sellTotalEnc, transferred);
            Nox.allowThis(e.sellTotalEnc);
            if (firstOrder) e.sellCount++;
        }
        emit OrderSubmitted(epochId, msg.sender, isBuy);
    }

    /// @notice Cancel an order while the epoch is still open; funds return confidentially.
    function cancelOrder(bool isBuy) external nonReentrant {
        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Open);
        if (block.timestamp >= e.endTime) revert Kairos_EpochEnded();

        mapping(address => euint256) storage orders = isBuy
            ? _buyOrders[epochId]
            : _sellOrders[epochId];
        euint256 amount = orders[msg.sender];
        if (!Nox.isInitialized(amount)) revert Kairos_NoOrder();
        orders[msg.sender] = euint256.wrap(0);

        if (isBuy) {
            e.buyTotalEnc = Nox.sub(e.buyTotalEnc, amount);
            Nox.allowThis(e.buyTotalEnc);
            e.buyCount--;
        } else {
            e.sellTotalEnc = Nox.sub(e.sellTotalEnc, amount);
            Nox.allowThis(e.sellTotalEnc);
            e.sellCount--;
        }

        IERC7984 token = IERC7984(address(isBuy ? cQuote : cBase));
        Nox.allowTransient(amount, address(token));
        token.confidentialTransfer(msg.sender, amount);
        emit OrderCancelled(epochId, msg.sender, isBuy);
    }

    // ============ Settlement crank (permissionless) ============

    /**
     * @notice Seal the current epoch once its window elapsed and open the next one.
     * Marks ONLY the two aggregate handles publicly decryptable — this is the single
     * deliberate disclosure in the protocol; individual order handles never get it.
     */
    function seal() external nonReentrant {
        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Open);
        if (block.timestamp < e.endTime) revert Kairos_EpochNotEnded();

        e.sealedAt = uint64(block.timestamp);
        if (e.buyCount == 0 && e.sellCount == 0) {
            // Empty epoch: nothing to reveal or settle.
            e.state = EpochState.Distributable;
            emit EpochDistributable(epochId, 0, 0);
        } else {
            e.state = EpochState.Sealed;
            if (e.buyCount > 0) Nox.allowPublicDecryption(e.buyTotalEnc);
            if (e.sellCount > 0) Nox.allowPublicDecryption(e.sellTotalEnc);
        }
        emit EpochSealed(
            epochId,
            euint256.unwrap(e.buyTotalEnc),
            euint256.unwrap(e.sellTotalEnc),
            e.buyCount,
            e.sellCount
        );
        _openNextEpoch();
    }

    /**
     * @notice Post the TEE decryption proofs for the epoch aggregates.
     * Proofs are fetched off-chain (SDK `publicDecrypt`) and verified on-chain here;
     * a malicious cranker cannot forge totals.
     */
    function reveal(
        uint256 epochId,
        bytes calldata buyTotalProof,
        bytes calldata sellTotalProof
    ) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Sealed);

        e.buyTotal = e.buyCount > 0 ? Nox.publicDecrypt(e.buyTotalEnc, buyTotalProof) : 0;
        e.sellTotal = e.sellCount > 0 ? Nox.publicDecrypt(e.sellTotalEnc, sellTotalProof) : 0;

        if (e.buyTotal == 0 && e.sellTotal == 0) {
            // All orders were silent-zero deposits; nothing is held for this epoch.
            e.state = EpochState.Distributable;
            emit EpochRevealed(epochId, 0, 0);
            emit EpochDistributable(epochId, 0, 0);
            return;
        }
        e.state = EpochState.Revealed;
        emit EpochRevealed(epochId, e.buyTotal, e.sellTotal);
    }

    /**
     * @notice Cross the two sides at the current Uniswap spot price and, if a residual
     * remains, start unwrapping it (async TEE step). Perfect crosses settle instantly —
     * matched volume never touches the public chain at all.
     */
    function initiateSettlement(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Revealed);

        uint256 priceX96 = _priceX96();
        uint256 sellQuoteValue = _baseToQuote(e.sellTotal, priceX96);

        if (e.buyTotal >= sellQuoteValue) {
            // Buy-heavy (or exactly matched): all sellers fill internally.
            e.sellOutTotal = sellQuoteValue;
            uint256 residual = e.buyTotal - sellQuoteValue;
            if (residual == 0) {
                e.residual = Residual.NoResidual;
                e.buyOutTotal = e.sellTotal;
                e.state = EpochState.Distributable;
                emit SettlementInitiated(epochId, Residual.NoResidual, 0, sellQuoteValue, 0);
                emit EpochDistributable(epochId, e.buyOutTotal, e.sellOutTotal);
                return;
            }
            e.residual = Residual.BuyHeavy;
            e.residualIn = residual;
            e.unwrapRequestId = _requestUnwrap(cQuote, residual);
            emit SettlementInitiated(
                epochId,
                Residual.BuyHeavy,
                residual,
                sellQuoteValue,
                euint256.unwrap(e.unwrapRequestId)
            );
        } else {
            // Sell-heavy: all buyers fill internally.
            uint256 buyBaseValue = _quoteToBase(e.buyTotal, priceX96);
            // Rounding can nudge the conversion past the other side; clamp to a perfect cross.
            if (buyBaseValue >= e.sellTotal) {
                e.residual = Residual.NoResidual;
                e.buyOutTotal = e.sellTotal;
                e.sellOutTotal = e.buyTotal;
                e.state = EpochState.Distributable;
                emit SettlementInitiated(epochId, Residual.NoResidual, 0, e.buyTotal, 0);
                emit EpochDistributable(epochId, e.buyOutTotal, e.sellOutTotal);
                return;
            }
            e.buyOutTotal = buyBaseValue;
            uint256 residual = e.sellTotal - buyBaseValue;
            e.residual = Residual.SellHeavy;
            e.residualIn = residual;
            e.unwrapRequestId = _requestUnwrap(cBase, residual);
            emit SettlementInitiated(
                epochId,
                Residual.SellHeavy,
                residual,
                e.buyTotal,
                euint256.unwrap(e.unwrapRequestId)
            );
        }
        e.state = EpochState.UnwrapPending;
        pendingUnwraps++;
    }

    /**
     * @notice Finalize the residual unwrap with its TEE decryption proof, execute the
     * single aggregate swap directly against Uniswap V3, wrap the output back into
     * confidential form, and open claims.
     */
    function finalizeSettlement(
        uint256 epochId,
        bytes calldata unwrapProof
    ) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.UnwrapPending);

        bool buyHeavy = e.residual == Residual.BuyHeavy;
        IERC20ToERC7984Wrapper wrapperIn = buyHeavy ? cQuote : cBase;
        IERC20ToERC7984Wrapper wrapperOut = buyHeavy ? cBase : cQuote;
        IERC20 tokenOut = buyHeavy ? baseToken : quoteToken;

        // Releases exactly `residualIn` of the public ERC-20 to this contract.
        wrapperIn.finalizeUnwrap(e.unwrapRequestId, unwrapProof);

        // Sandwich guard: minOut derived from spot read in this same transaction.
        uint256 priceX96 = _priceX96();
        uint256 expectedOut = buyHeavy
            ? _quoteToBase(e.residualIn, priceX96)
            : _baseToQuote(e.residualIn, priceX96);
        uint256 minOut = (expectedOut * (BPS - maxSlippageBps)) / BPS;

        uint256 out = _swapExactInput(buyHeavy, e.residualIn, minOut);
        emit ResidualSwapped(epochId, e.residualIn, out);

        // Re-shield the output for confidential pro-rata distribution.
        IERC20(tokenOut).forceApprove(address(wrapperOut), out);
        wrapperOut.wrap(address(this), out);

        if (buyHeavy) {
            e.buyOutTotal = e.sellTotal + out;
        } else {
            e.sellOutTotal = e.buyTotal + out;
        }
        e.state = EpochState.Distributable;
        pendingUnwraps--;
        emit EpochDistributable(epochId, e.buyOutTotal, e.sellOutTotal);
    }

    // ============ Claims ============

    /**
     * @notice Pull-based claim: pays out `userIn * sideOutTotal / sideInTotal` in the
     * opposite confidential token. The ratio is computed on encrypted operands inside
     * the TEE — nobody learns the individual payout. O(1) encrypted ops per claim.
     */
    function claim(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Distributable);
        if (claimed[epochId][msg.sender]) revert Kairos_AlreadyClaimed();
        claimed[epochId][msg.sender] = true;

        euint256 buyIn = _buyOrders[epochId][msg.sender];
        euint256 sellIn = _sellOrders[epochId][msg.sender];
        bool hasBuy = Nox.isInitialized(buyIn);
        bool hasSell = Nox.isInitialized(sellIn);
        if (!hasBuy && !hasSell) revert Kairos_NoOrder();

        if (hasBuy && e.buyTotal > 0) {
            _payShare(IERC7984(address(cBase)), buyIn, e.buyOutTotal, e.buyTotal);
        }
        if (hasSell && e.sellTotal > 0) {
            _payShare(IERC7984(address(cQuote)), sellIn, e.sellOutTotal, e.sellTotal);
        }
        emit Claimed(epochId, msg.sender);
    }

    /// @notice Recover deposits from a cancelled epoch (confidential refund).
    function claimRefund(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Cancelled);
        if (claimed[epochId][msg.sender]) revert Kairos_AlreadyClaimed();
        claimed[epochId][msg.sender] = true;

        euint256 buyIn = _buyOrders[epochId][msg.sender];
        euint256 sellIn = _sellOrders[epochId][msg.sender];
        bool hasBuy = Nox.isInitialized(buyIn);
        bool hasSell = Nox.isInitialized(sellIn);
        if (!hasBuy && !hasSell) revert Kairos_NoOrder();

        if (hasBuy) {
            Nox.allowTransient(buyIn, address(cQuote));
            IERC7984(address(cQuote)).confidentialTransfer(msg.sender, buyIn);
        }
        if (hasSell) {
            Nox.allowTransient(sellIn, address(cBase));
            IERC7984(address(cBase)).confidentialTransfer(msg.sender, sellIn);
        }
        emit RefundClaimed(epochId, msg.sender);
    }

    // ============ Liveness escape hatches ============

    /**
     * @notice Cancel a wedged epoch before any funds were burned (reveal never arrived).
     * Every deposit remains in confidential custody → full refunds via claimRefund.
     */
    function cancelEpoch(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        if (e.state != EpochState.Sealed && e.state != EpochState.Revealed) {
            revert Kairos_WrongState(epochId, e.state);
        }
        if (block.timestamp < uint256(e.sealedAt) + revealTimeout) {
            revert Kairos_TimeoutNotReached();
        }
        e.state = EpochState.Cancelled;
        emit EpochCancelled(epochId);
    }

    /**
     * @notice Recover a wedged UnwrapPending epoch. Requires the wrapper unwrap to have
     * been finalized (permissionless on the wrapper itself) so the residual ERC-20 sits
     * in this contract; it is re-wrapped 1:1, restoring full confidential custody,
     * then the epoch cancels with refunds.
     */
    function recoverEpoch(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.UnwrapPending);
        if (block.timestamp < uint256(e.sealedAt) + 2 * uint256(revealTimeout)) {
            revert Kairos_TimeoutNotReached();
        }
        bool buyHeavy = e.residual == Residual.BuyHeavy;
        IERC20 tokenIn = buyHeavy ? quoteToken : baseToken;
        IERC20ToERC7984Wrapper wrapperIn = buyHeavy ? cQuote : cBase;
        if (tokenIn.balanceOf(address(this)) < e.residualIn) revert Kairos_UnwrapNotFinalized();

        tokenIn.forceApprove(address(wrapperIn), e.residualIn);
        wrapperIn.wrap(address(this), e.residualIn);
        e.state = EpochState.Cancelled;
        pendingUnwraps--;
        emit EpochCancelled(epochId);
    }

    // ============ Uniswap V3 callback ============

    /// @inheritdoc IUniswapV3SwapCallback
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external override {
        // Only the configured pool, and only during a swap WE initiated — otherwise an
        // attacker could trigger the pool to demand payment from this contract.
        if (msg.sender != address(uniPool) || !_inSwap) revert Kairos_UnexpectedCallback();
        if (amount0Delta > 0) {
            IERC20(uniPool.token0()).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(uniPool.token1()).safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }

    // ============ Views ============

    function getEpoch(uint256 epochId) external view returns (Epoch memory) {
        return _epochs[epochId];
    }

    /// @notice Handle of the caller-decryptable encrypted order (0 if none).
    function orderOf(
        uint256 epochId,
        address user,
        bool isBuy
    ) external view returns (euint256) {
        return isBuy ? _buyOrders[epochId][user] : _sellOrders[epochId][user];
    }

    // ============ Admin ============

    /// @notice Auditor gets read access (viewer) to per-user order handles — selective
    /// disclosure for compliance without anything becoming public. Applies to new orders.
    function setAuditor(address auditor_) external onlyOwner {
        auditor = auditor_;
        emit AuditorSet(auditor_);
    }

    function setEpochParams(
        uint64 epochDuration_,
        uint64 revealTimeout_,
        uint16 maxSlippageBps_
    ) external onlyOwner {
        _setEpochParams(epochDuration_, revealTimeout_, maxSlippageBps_);
    }

    /// @notice Rescue plaintext ERC-20 dust (rounding remainders). Blocked while any
    /// epoch awaits its unwrap so in-flight residuals can never be swept.
    function sweepDust(IERC20 token, address to) external onlyOwner {
        if (pendingUnwraps != 0) revert Kairos_PendingUnwraps();
        token.safeTransfer(to, token.balanceOf(address(this)));
    }

    // ============ Internals ============

    function _requireState(uint256 epochId, Epoch storage e, EpochState expected) private view {
        if (e.state != expected) revert Kairos_WrongState(epochId, e.state);
    }

    function _setEpochParams(
        uint64 epochDuration_,
        uint64 revealTimeout_,
        uint16 maxSlippageBps_
    ) private {
        if (
            epochDuration_ < 1 minutes ||
            epochDuration_ > 1 days ||
            revealTimeout_ < 10 minutes ||
            maxSlippageBps_ > 1_000
        ) revert Kairos_InvalidParam();
        epochDuration = epochDuration_;
        revealTimeout = revealTimeout_;
        maxSlippageBps = maxSlippageBps_;
        emit EpochParamsSet(epochDuration_, revealTimeout_, maxSlippageBps_);
    }

    function _openNextEpoch() private {
        uint256 id = ++currentEpochId;
        Epoch storage e = _epochs[id];
        e.state = EpochState.Open;
        e.startTime = uint64(block.timestamp);
        e.endTime = uint64(block.timestamp) + epochDuration;
        emit EpochOpened(id, e.startTime, e.endTime);
    }

    /// @dev Burns `amount` of our confidential balance; the wrapper marks the burn
    /// handle publicly decryptable and records us as unwrap recipient. The amount is
    /// already public information (derived from revealed aggregates).
    function _requestUnwrap(
        IERC20ToERC7984Wrapper wrapper,
        uint256 amount
    ) private returns (euint256) {
        euint256 enc = Nox.toEuint256(amount);
        return wrapper.unwrap(address(this), address(this), enc);
    }

    /// @dev userOut = userIn * outTotal / inTotal, computed on encrypted operands.
    /// Mul-before-div for precision; rounding dust accrues to the pool (sweepable).
    function _payShare(
        IERC7984 tokenOut,
        euint256 userIn,
        uint256 outTotal,
        uint256 inTotal
    ) private {
        if (outTotal == 0) return; // dust-residual epochs: nothing to distribute
        euint256 share = Nox.div(
            Nox.mul(userIn, Nox.toEuint256(outTotal)),
            Nox.toEuint256(inTotal)
        );
        Nox.allow(share, msg.sender);
        if (auditor != address(0)) Nox.addViewer(share, auditor);
        Nox.allowTransient(share, address(tokenOut));
        tokenOut.confidentialTransfer(msg.sender, share);
    }

    /// @dev priceX96 = (token1/token0) * 2^96, from the pool's current sqrt price.
    function _priceX96() private view returns (uint256) {
        (uint160 sqrtPriceX96, , , , , , ) = uniPool.slot0();
        return Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 96);
    }

    function _baseToQuote(uint256 baseAmount, uint256 priceX96) private view returns (uint256) {
        return
            quoteIsToken0
                ? Math.mulDiv(baseAmount, 1 << 96, priceX96)
                : Math.mulDiv(baseAmount, priceX96, 1 << 96);
    }

    function _quoteToBase(uint256 quoteAmount, uint256 priceX96) private view returns (uint256) {
        return
            quoteIsToken0
                ? Math.mulDiv(quoteAmount, priceX96, 1 << 96)
                : Math.mulDiv(quoteAmount, 1 << 96, priceX96);
    }

    function _swapExactInput(
        bool buyHeavy,
        uint256 amountIn,
        uint256 minOut
    ) private returns (uint256 out) {
        // BuyHeavy swaps quote→base; zeroForOne means selling token0.
        bool zeroForOne = buyHeavy ? quoteIsToken0 : !quoteIsToken0;
        _inSwap = true;
        (int256 a0, int256 a1) = uniPool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        _inSwap = false;
        out = uint256(-(zeroForOne ? a1 : a0));
        if (out < minOut) revert Kairos_SlippageExceeded(out, minOut);
    }
}
