// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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
 * internally at the Uniswap price and ONLY the unmatched residual is swapped against
 * the canonical, unmodified Uniswap V3 pool. Individual order sizes are never revealed:
 * only the two epoch aggregates are ever publicly decrypted, and only when enough
 * participants are present for the aggregate to actually hide them.
 *
 * Directions: BUY  = deposit quote (cUSDC), receive base (cWETH).
 *             SELL = deposit base (cWETH), receive quote (cUSDC).
 *
 * Epoch lifecycle (each transition is permissionless, idempotent, state-guarded):
 *   Open → Sealed → Revealed → UnwrapPending → Distributable
 *     └──────┴─────────┴────────────┴──────────→ Cancelled (full refunds)
 * Settlement is asynchronous by design: public decryption of aggregates and the
 * wrapper unwrap each require an off-chain Nox TEE round-trip.
 *
 * SECURITY MODEL
 *  - Price manipulation: both the internal cross and the residual swap require spot
 *    to sit within `maxTickDeviation` of the pool's `twapWindow` TWAP, so a
 *    flash-manipulated price cannot set the clearing rate. The residual swap
 *    additionally takes a caller-supplied `minOut` (off-chain quote) which may only
 *    TIGHTEN the on-chain floor — a malicious cranker can abort, never underfill.
 *  - Fund attribution: each epoch's unwrapped residual is tracked in `escrowedIn`,
 *    and every consumption path proves the balance covers ALL outstanding escrows.
 *    One epoch can never spend another's custody, and settlements need not serialize.
 *  - Liveness: no state can strand funds. Open epochs have an emergency cancel,
 *    Sealed/Revealed have `cancelEpoch`, UnwrapPending has `recoverEpoch` (residual
 *    released) and `abandonEpoch` (residual permanently lost at the wrapper) — the
 *    latter can never zero out a funded side's payout.
 *  - Parameters are SNAPSHOT per epoch at open time, so owner changes can never
 *    retroactively move an in-flight epoch's deadlines, privacy floor or slippage.
 *
 * KNOWN LIMITATIONS (deliberate, documented for reviewers)
 *  - Order DIRECTION and participation are public metadata; only amounts are hidden.
 *  - `buyCount`/`sellCount` are an UPPER BOUND on real participants: an ERC-7984
 *    transfer that exceeds the sender's balance silently moves 0 but still registers.
 *    A sybil can therefore inflate the counts that `minOrders` gates on without
 *    committing capital. Raising the k-anonymity floor mitigates but does not remove
 *    this; a capital-weighted floor is the production fix.
 *  - The heavy side absorbs the Uniswap fee and price impact of the residual, while
 *    the internally-crossed volume clears at the (TWAP-validated) pool price.
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
        Residual residual;
        uint64 startTime;
        uint64 endTime;
        uint64 sealedAt;
        uint64 unwrapRequestedAt;
        uint32 buyCount; // distinct buy participants (upper bound, see limitations)
        uint32 sellCount; // distinct sell participants (upper bound)
        // --- parameters snapshotted at epoch open (immune to later owner changes) ---
        uint64 revealTimeoutSnap;
        uint64 unwrapTimeoutSnap;
        uint32 minOrdersSnap;
        uint16 maxSlippageBpsSnap;
        address auditorSnap;
        // --- encrypted state ---
        euint256 buyTotalEnc; // encrypted sum of actual buy deposits (quote units)
        euint256 sellTotalEnc; // encrypted sum of actual sell deposits (base units)
        euint256 unwrapRequestId; // wrapper unwrap request handle
        // --- plaintext, only after reveal ---
        uint256 buyTotal;
        uint256 sellTotal;
        uint256 residualIn;
        uint256 buyOutTotal; // base units owed to buyers (final at Distributable)
        uint256 sellOutTotal; // quote units owed to sellers (final at Distributable)
    }

    // ============ Errors ============

    error Kairos_WrongState(uint256 epochId, EpochState actual);
    error Kairos_EpochNotEnded();
    error Kairos_EpochEnded();
    error Kairos_TimeoutNotReached();
    error Kairos_NoOrder();
    error Kairos_NothingToClaim();
    error Kairos_AlreadyClaimed();
    error Kairos_SlippageExceeded(uint256 got, uint256 minOut);
    error Kairos_PriceDeviation(int24 spotTick, int24 twapTick);
    error Kairos_UnexpectedCallback();
    error Kairos_UnwrapNotFinalized();
    error Kairos_UnwrapAlreadyFinalized();
    error Kairos_InsufficientEscrow();
    error Kairos_PartialSwap(uint256 consumed, uint256 expected);
    error Kairos_ZeroPayout();
    error Kairos_InvalidParam();

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
    event EpochCancelled(uint256 indexed epochId, string reason);
    event EpochAbandoned(uint256 indexed epochId, uint256 lostResidual);
    event Claimed(uint256 indexed epochId, address indexed user);
    event RefundClaimed(uint256 indexed epochId, address indexed user);
    event AuditorSet(address auditor);
    event EpochParamsSet(
        uint64 epochDuration,
        uint64 revealTimeout,
        uint64 unwrapTimeout,
        uint16 maxSlippageBps,
        uint32 minOrders
    );
    event PriceGuardSet(uint32 twapWindow, uint24 maxTickDeviation);

    // ============ Immutables ============

    IERC20 public immutable quoteToken; // e.g. tUSDC (public ERC-20)
    IERC20 public immutable baseToken; // e.g. WETH (public ERC-20)
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
    uint64 public revealTimeout; // Sealed/Revealed → cancellable after this
    uint64 public unwrapTimeout; // UnwrapPending → recoverable after this (3x → abandon)
    uint16 public maxSlippageBps;
    uint32 public minOrders; // per-side k-anonymity floor for revealing an aggregate
    uint32 public twapWindow; // seconds; 0 disables the price-deviation guard
    uint24 public maxTickDeviation; // allowed |spot - twap| in ticks (~1 tick = 1 bp)
    address public auditor; // optional selective-disclosure viewer

    uint256 public currentEpochId;
    mapping(uint256 epochId => Epoch) private _epochs;
    mapping(uint256 epochId => mapping(address user => euint256)) private _buyOrders;
    mapping(uint256 epochId => mapping(address user => euint256)) private _sellOrders;
    mapping(uint256 epochId => mapping(address user => bool)) public claimed;

    /// @notice Plaintext ERC-20 owed to epochs whose residual was unwrapped but not yet
    /// consumed. Guarantees per-epoch attribution and bounds `sweepDust`.
    mapping(address token => uint256) public escrowedIn;

    /// @dev Reentrancy-style guard: only accept the Uniswap callback we initiated.
    bool private _inSwap;

    // ============ Constructor ============

    constructor(
        IERC20ToERC7984Wrapper cQuote_,
        IERC20ToERC7984Wrapper cBase_,
        IUniswapV3PoolMinimal uniPool_,
        uint64 epochDuration_,
        uint64 revealTimeout_,
        uint64 unwrapTimeout_,
        uint16 maxSlippageBps_,
        uint32 minOrders_,
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

        // An uninitialized pool has sqrtPriceX96 == 0, which would make every price
        // conversion divide by zero. Fail at deploy time, not at settlement time.
        (uint160 sqrtPriceX96, , , , , , ) = uniPool_.slot0();
        if (sqrtPriceX96 == 0) revert Kairos_InvalidParam();

        _setEpochParams(
            epochDuration_,
            revealTimeout_,
            unwrapTimeout_,
            maxSlippageBps_,
            minOrders_
        );
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
        if (e.auditorSnap != address(0)) Nox.addViewer(newOrder, e.auditorSnap);
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

    /**
     * @notice Cancel an order before the epoch is sealed; funds return confidentially.
     * @dev Deliberately allowed in the window between `endTime` and `seal()`: the
     * aggregate is not yet publicly decryptable, so this leaks nothing, and it keeps
     * deposits withdrawable if nobody cranks `seal()`.
     */
    function cancelOrder(bool isBuy) external nonReentrant {
        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Open);

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
     * Marks ONLY the two aggregate handles publicly decryptable — the single
     * deliberate disclosure in the protocol.
     *
     * @dev PRIVACY GUARD: a side with fewer than `minOrders` participants would have
     * an "aggregate" that reveals (or trivially unmasks) an individual order, so the
     * epoch is cancelled for full refunds instead of being revealed. Refusing to
     * settle is always preferable to silently breaking the privacy guarantee.
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
        } else if (
            (e.buyCount > 0 && e.buyCount < e.minOrdersSnap) ||
            (e.sellCount > 0 && e.sellCount < e.minOrdersSnap)
        ) {
            e.state = EpochState.Cancelled;
            emit EpochCancelled(epochId, "insufficient participants for privacy");
        } else {
            e.state = EpochState.Sealed;
            if (e.buyCount > 0) Nox.allowPublicDecryption(e.buyTotalEnc);
            if (e.sellCount > 0) Nox.allowPublicDecryption(e.sellTotalEnc);
            emit EpochSealed(
                epochId,
                euint256.unwrap(e.buyTotalEnc),
                euint256.unwrap(e.sellTotalEnc),
                e.buyCount,
                e.sellCount
            );
        }
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
     * @notice Cross the two sides at the (TWAP-validated) pool price and, if a residual
     * remains, start unwrapping it (async TEE step). Perfect crosses settle instantly —
     * matched volume never touches the public chain at all.
     */
    function initiateSettlement(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Revealed);

        // The cross rate must not be settable by a flash loan.
        _requireSpotNearTwap();
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
            escrowedIn[address(quoteToken)] += residual;
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
            e.buyOutTotal = buyBaseValue;
            uint256 residual = e.sellTotal - buyBaseValue;
            e.residual = Residual.SellHeavy;
            e.residualIn = residual;
            e.unwrapRequestId = _requestUnwrap(cBase, residual);
            escrowedIn[address(baseToken)] += residual;
            emit SettlementInitiated(
                epochId,
                Residual.SellHeavy,
                residual,
                e.buyTotal,
                euint256.unwrap(e.unwrapRequestId)
            );
        }
        e.unwrapRequestedAt = uint64(block.timestamp);
        e.state = EpochState.UnwrapPending;
    }

    /**
     * @notice Finalize the residual unwrap with its TEE decryption proof, execute the
     * single aggregate swap directly against Uniswap V3, wrap the output back into
     * confidential form, and open claims.
     *
     * @param minOut Caller-supplied floor from an off-chain quote (e.g. QuoterV2). It
     * may only TIGHTEN the on-chain spot-derived floor, so a hostile cranker can abort
     * the settlement but can never make users accept a worse fill.
     */
    function finalizeSettlement(
        uint256 epochId,
        bytes calldata unwrapProof,
        uint256 minOut
    ) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.UnwrapPending);
        _requireSpotNearTwap();

        bool buyHeavy = e.residual == Residual.BuyHeavy;
        IERC20ToERC7984Wrapper wrapperIn = buyHeavy ? cQuote : cBase;
        IERC20ToERC7984Wrapper wrapperOut = buyHeavy ? cBase : cQuote;
        IERC20 tokenIn = buyHeavy ? quoteToken : baseToken;
        IERC20 tokenOut = buyHeavy ? baseToken : quoteToken;

        _releaseResidual(wrapperIn, tokenIn, e.unwrapRequestId, e.residualIn, unwrapProof);
        // Consume this epoch's escrow before spending, so a reentrant or racing path
        // can never double-spend the same residual.
        escrowedIn[address(tokenIn)] -= e.residualIn;

        // Floor: spot-derived (TWAP-validated above), tightened by the caller's quote.
        uint256 priceX96 = _priceX96();
        uint256 expectedOut = buyHeavy
            ? _quoteToBase(e.residualIn, priceX96)
            : _baseToQuote(e.residualIn, priceX96);
        uint256 floorOut = (expectedOut * (BPS - e.maxSlippageBpsSnap)) / BPS;
        if (minOut > floorOut) floorOut = minOut;

        uint256 out = _swapExactInput(buyHeavy, e.residualIn, floorOut);
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

        euint256 buyIn = _buyOrders[epochId][msg.sender];
        euint256 sellIn = _sellOrders[epochId][msg.sender];
        bool hasBuy = Nox.isInitialized(buyIn);
        bool hasSell = Nox.isInitialized(sellIn);
        if (!hasBuy && !hasSell) revert Kairos_NoOrder();

        // A funded side must never be consumed for a zero payout: refuse the claim so
        // the position stays claimable if the epoch is later made whole.
        if (hasBuy && e.buyTotal > 0 && e.buyOutTotal == 0) revert Kairos_ZeroPayout();
        if (hasSell && e.sellTotal > 0 && e.sellOutTotal == 0) revert Kairos_ZeroPayout();

        claimed[epochId][msg.sender] = true;

        if (hasBuy && e.buyTotal > 0) {
            _payShare(IERC7984(address(cBase)), buyIn, e.buyOutTotal, e.buyTotal, e.auditorSnap);
        }
        if (hasSell && e.sellTotal > 0) {
            _payShare(IERC7984(address(cQuote)), sellIn, e.sellOutTotal, e.sellTotal, e.auditorSnap);
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
     * @notice Cancel a wedged epoch before any funds were burned (reveal never arrived,
     * or settlement never cranked). Deposits remain in confidential custody → full
     * refunds via claimRefund.
     */
    function cancelEpoch(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        if (e.state != EpochState.Sealed && e.state != EpochState.Revealed) {
            revert Kairos_WrongState(epochId, e.state);
        }
        if (block.timestamp < uint256(e.sealedAt) + e.revealTimeoutSnap) {
            revert Kairos_TimeoutNotReached();
        }
        e.state = EpochState.Cancelled;
        emit EpochCancelled(epochId, "reveal/settlement timeout");
    }

    /**
     * @notice Rescue an epoch whose residual WAS released by the wrapper but whose swap
     * never completed (e.g. slippage bound unreachable). The plaintext residual is
     * re-wrapped 1:1, restoring full confidential custody, then the epoch cancels with
     * refunds.
     */
    function recoverEpoch(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.UnwrapPending);
        if (block.timestamp < uint256(e.unwrapRequestedAt) + e.unwrapTimeoutSnap) {
            revert Kairos_TimeoutNotReached();
        }
        bool buyHeavy = e.residual == Residual.BuyHeavy;
        IERC20 tokenIn = buyHeavy ? quoteToken : baseToken;
        IERC20ToERC7984Wrapper wrapperIn = buyHeavy ? cQuote : cBase;

        // Only valid once this epoch's own request has been finalized (permissionlessly
        // callable on the wrapper) and the balance covers every outstanding escrow.
        if (wrapperIn.unwrapRequester(e.unwrapRequestId) != address(0)) {
            revert Kairos_UnwrapNotFinalized();
        }
        if (tokenIn.balanceOf(address(this)) < escrowedIn[address(tokenIn)]) {
            revert Kairos_InsufficientEscrow();
        }
        escrowedIn[address(tokenIn)] -= e.residualIn;

        tokenIn.forceApprove(address(wrapperIn), e.residualIn);
        wrapperIn.wrap(address(this), e.residualIn);
        e.state = EpochState.Cancelled;
        emit EpochCancelled(epochId, "residual recovered, refunds open");
    }

    /**
     * @notice Last-resort escape for the catastrophic case where the TEE never produces
     * the unwrap decryption: the residual is burned at the wrapper and can never be
     * released. Settles the epoch on its INTERNAL cross only — the matched volume
     * distributes normally from funds the pool still holds, and only the heavy side
     * absorbs the lost residual, pro-rata.
     *
     * @dev Guarded so it can never destroy value that is actually recoverable:
     *  - reverts if the unwrap HAS been finalized (use `recoverEpoch` — full refunds);
     *  - reverts if the write-off would leave a funded side with a zero payout (a
     *    one-sided epoch), because leaving it in UnwrapPending keeps it rescuable
     *    forever should the TEE recover, which strictly dominates writing it off.
     */
    function abandonEpoch(uint256 epochId) external nonReentrant {
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.UnwrapPending);
        if (block.timestamp < uint256(e.unwrapRequestedAt) + 3 * uint256(e.unwrapTimeoutSnap)) {
            revert Kairos_TimeoutNotReached();
        }
        bool buyHeavy = e.residual == Residual.BuyHeavy;
        IERC20ToERC7984Wrapper wrapperIn = buyHeavy ? cQuote : cBase;
        if (wrapperIn.unwrapRequester(e.unwrapRequestId) == address(0)) {
            revert Kairos_UnwrapAlreadyFinalized();
        }
        if (buyHeavy) {
            if (e.sellTotal == 0) revert Kairos_ZeroPayout();
            e.buyOutTotal = e.sellTotal; // internal cross only; residual quote is lost
        } else {
            if (e.buyTotal == 0) revert Kairos_ZeroPayout();
            e.sellOutTotal = e.buyTotal; // internal cross only; residual base is lost
        }
        // The residual will never arrive: drop its escrow claim.
        IERC20 tokenIn = buyHeavy ? quoteToken : baseToken;
        escrowedIn[address(tokenIn)] -= e.residualIn;

        e.state = EpochState.Distributable;
        emit EpochAbandoned(epochId, e.residualIn);
        emit EpochDistributable(epochId, e.buyOutTotal, e.sellOutTotal);
    }

    /**
     * @notice Break-glass for a dead `seal()` (e.g. Nox unavailable): after the epoch
     * window plus a full reveal timeout, anyone may cancel the open epoch for refunds
     * and open a fresh one. Without this, a failing `seal()` would strand deposits and
     * halt the protocol permanently, since new epochs open only inside `seal()`.
     */
    function emergencyCancelOpenEpoch() external nonReentrant {
        uint256 epochId = currentEpochId;
        Epoch storage e = _epochs[epochId];
        _requireState(epochId, e, EpochState.Open);
        if (block.timestamp < uint256(e.endTime) + e.revealTimeoutSnap) {
            revert Kairos_TimeoutNotReached();
        }
        e.state = EpochState.Cancelled;
        emit EpochCancelled(epochId, "seal unavailable");
        _openNextEpoch();
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

    /// @notice Plaintext ERC-20 not spoken for by any pending epoch residual.
    function sweepableDust(IERC20 token) public view returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        uint256 escrowed = escrowedIn[address(token)];
        return balance > escrowed ? balance - escrowed : 0;
    }

    // ============ Admin ============

    /// @notice Auditor gets read access (viewer) to order and payout handles —
    /// selective disclosure for compliance without anything becoming public. Applies
    /// only to epochs opened AFTER this call: each epoch snapshots the auditor, so a
    /// newly appointed auditor can never see historic orders.
    /// @dev The Nox ACL has no `removeViewer`: viewer grants are PERMANENT. Point this
    /// at a proxy contract if you need key rotation.
    function setAuditor(address auditor_) external onlyOwner {
        auditor = auditor_;
        emit AuditorSet(auditor_);
    }

    function setEpochParams(
        uint64 epochDuration_,
        uint64 revealTimeout_,
        uint64 unwrapTimeout_,
        uint16 maxSlippageBps_,
        uint32 minOrders_
    ) external onlyOwner {
        _setEpochParams(
            epochDuration_,
            revealTimeout_,
            unwrapTimeout_,
            maxSlippageBps_,
            minOrders_
        );
    }

    /// @notice Configure the spot-vs-TWAP deviation guard. `twapWindow_ == 0` disables
    /// it — only acceptable on a pool without observation history, and it re-exposes
    /// settlement to price manipulation.
    function setPriceGuard(uint32 twapWindow_, uint24 maxTickDeviation_) external onlyOwner {
        if (twapWindow_ > 1 days || maxTickDeviation_ > 10_000) revert Kairos_InvalidParam();
        twapWindow = twapWindow_;
        maxTickDeviation = maxTickDeviation_;
        emit PriceGuardSet(twapWindow_, maxTickDeviation_);
    }

    /// @notice Rescue plaintext ERC-20 dust (rounding remainders, donations, residuals
    /// stranded by an abandoned epoch). Can never touch escrowed residuals.
    function sweepDust(IERC20 token, address to) external onlyOwner {
        token.safeTransfer(to, sweepableDust(token));
    }

    // ============ Internals ============

    function _requireState(uint256 epochId, Epoch storage e, EpochState expected) private view {
        if (e.state != expected) revert Kairos_WrongState(epochId, e.state);
    }

    function _setEpochParams(
        uint64 epochDuration_,
        uint64 revealTimeout_,
        uint64 unwrapTimeout_,
        uint16 maxSlippageBps_,
        uint32 minOrders_
    ) private {
        // Slippage floor: below the Uniswap fee tier (30 bps) plus minimal impact, the
        // residual swap could never satisfy its floor and every settlement would wedge.
        // Timeouts are bounded on BOTH sides so the owner can neither disable the
        // escape hatches nor force-cancel live epochs.
        if (
            epochDuration_ < 1 minutes ||
            epochDuration_ > 1 days ||
            revealTimeout_ < 10 minutes ||
            revealTimeout_ > 7 days ||
            unwrapTimeout_ < 5 minutes ||
            unwrapTimeout_ > 1 days ||
            maxSlippageBps_ < 50 ||
            maxSlippageBps_ > 1_000 ||
            minOrders_ == 0 ||
            minOrders_ > 100
        ) revert Kairos_InvalidParam();
        epochDuration = epochDuration_;
        revealTimeout = revealTimeout_;
        unwrapTimeout = unwrapTimeout_;
        maxSlippageBps = maxSlippageBps_;
        minOrders = minOrders_;
        emit EpochParamsSet(
            epochDuration_,
            revealTimeout_,
            unwrapTimeout_,
            maxSlippageBps_,
            minOrders_
        );
    }

    function _openNextEpoch() private {
        uint256 id = ++currentEpochId;
        Epoch storage e = _epochs[id];
        e.state = EpochState.Open;
        e.startTime = uint64(block.timestamp);
        e.endTime = uint64(block.timestamp) + epochDuration;
        // Snapshot every parameter this epoch will be judged by, so later owner
        // changes cannot retroactively alter its deadlines, privacy floor or slippage.
        e.revealTimeoutSnap = revealTimeout;
        e.unwrapTimeoutSnap = unwrapTimeout;
        e.maxSlippageBpsSnap = maxSlippageBps;
        e.minOrdersSnap = minOrders;
        e.auditorSnap = auditor;
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

    /**
     * @dev Ensures `residualIn` of `tokenIn` is present and attributable to this epoch.
     * The wrapper's `finalizeUnwrap` is permissionless, so a third party may already
     * have called it; `unwrapRequester` (deleted by the wrapper on finalize) is the
     * authoritative discriminator. On the path we drive, the balance delta must equal
     * the residual exactly — a short burn would otherwise go unnoticed.
     */
    function _releaseResidual(
        IERC20ToERC7984Wrapper wrapper,
        IERC20 tokenIn,
        euint256 unwrapRequestId,
        uint256 residualIn,
        bytes calldata unwrapProof
    ) private {
        if (wrapper.unwrapRequester(unwrapRequestId) != address(0)) {
            uint256 balanceBefore = tokenIn.balanceOf(address(this));
            wrapper.finalizeUnwrap(unwrapRequestId, unwrapProof);
            if (tokenIn.balanceOf(address(this)) - balanceBefore != residualIn) {
                revert Kairos_UnwrapNotFinalized();
            }
        } else if (tokenIn.balanceOf(address(this)) < escrowedIn[address(tokenIn)]) {
            // Already finalized by someone else: the funds must still be here, and
            // covering EVERY outstanding escrow proves we are not spending another
            // epoch's residual.
            revert Kairos_InsufficientEscrow();
        }
    }

    /// @dev userOut = userIn * outTotal / inTotal, computed on encrypted operands.
    /// Mul-before-div for precision; floor division rounds toward the pool, so the
    /// last claimer can never be underfunded. Rounding dust is sweepable.
    function _payShare(
        IERC7984 tokenOut,
        euint256 userIn,
        uint256 outTotal,
        uint256 inTotal,
        address auditor_
    ) private {
        euint256 share = Nox.div(
            Nox.mul(userIn, Nox.toEuint256(outTotal)),
            Nox.toEuint256(inTotal)
        );
        Nox.allow(share, msg.sender);
        if (auditor_ != address(0)) Nox.addViewer(share, auditor_);
        Nox.allowTransient(share, address(tokenOut));
        tokenOut.confidentialTransfer(msg.sender, share);
    }

    /**
     * @dev Reverts unless the pool's spot price sits within `maxTickDeviation` of its
     * `twapWindow` TWAP. Ticks are log-space, so comparing them needs no price math:
     * 1 tick ≈ 1 basis point. This is what makes the spot-derived clearing rate and
     * slippage floor safe against same-block manipulation.
     */
    function _requireSpotNearTwap() private view {
        uint32 window = twapWindow;
        if (window == 0) return; // guard disabled (documented, owner-set)

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives, ) = uniPool.observe(secondsAgos);

        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 twapTick = int24(delta / int56(uint56(window)));
        // Uniswap rounds tick cumulatives toward negative infinity.
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) twapTick--;

        (, int24 spotTick, , , , , ) = uniPool.slot0();
        int24 diff = spotTick >= twapTick ? spotTick - twapTick : twapTick - spotTick;
        if (uint24(diff) > maxTickDeviation) revert Kairos_PriceDeviation(spotTick, twapTick);
    }

    /// @dev priceX96 = (token1/token0) * 2^96, from the pool's current sqrt price.
    function _priceX96() private view returns (uint256) {
        (uint160 sqrtPriceX96, , , , , , ) = uniPool.slot0();
        uint256 p = Math.mulDiv(uint256(sqrtPriceX96), uint256(sqrtPriceX96), 1 << 96);
        if (p == 0) revert Kairos_InvalidParam(); // unreachable at sane prices
        return p;
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
            SafeCast.toInt256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        _inSwap = false;

        // Defensive: a well-behaved pool always returns a negative output delta and
        // consumes the full exact input. Both are cheap to assert and both would
        // otherwise silently mis-account the payout.
        int256 outDelta = zeroForOne ? a1 : a0;
        int256 inDelta = zeroForOne ? a0 : a1;
        if (outDelta >= 0) revert Kairos_SlippageExceeded(0, minOut);
        if (uint256(inDelta) != amountIn) revert Kairos_PartialSwap(uint256(inDelta), amountIn);

        out = uint256(-outDelta);
        if (out < minOut) revert Kairos_SlippageExceeded(out, minOut);
    }
}
