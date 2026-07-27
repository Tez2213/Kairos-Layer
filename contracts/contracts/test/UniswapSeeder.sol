// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IUniswapV3PoolMinimal} from "../interfaces/IUniswapV3.sol";

interface IUniswapV3PoolSeed {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount,
        bytes calldata data
    ) external returns (uint256 amount0, uint256 amount1);
}

/**
 * @title UniswapSeeder
 * @notice TEST/DEPLOY helper: provides the mint and swap callbacks Uniswap V3 requires
 *         so a pool can be seeded with liquidity and primed with oracle observations
 *         without the periphery contracts. Fund it with both tokens, then call `seed`.
 *
 *         `prime` performs tiny swaps that write oracle observations — required before
 *         KairosPool's TWAP deviation guard can read `observe()`.
 *
 *         Deliberately unowned: it is a disposable utility that should never hold funds
 *         beyond a seeding transaction. `rescue` is open so leftovers are never stuck.
 */
contract UniswapSeeder {
    error NotPool();

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address private _pool;

    function seed(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        _pool = pool;
        IUniswapV3PoolSeed(pool).mint(address(this), tickLower, tickUpper, liquidity, "");
        _pool = address(0);
    }

    /// @notice Writes an oracle observation by executing a tiny swap.
    function prime(address pool, bool zeroForOne, uint256 amountIn) external {
        _pool = pool;
        IUniswapV3PoolMinimal(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        _pool = address(0);
    }

    /// @notice Recover any tokens left over after seeding (open by design — test tool).
    function rescue(IERC20 token, address to) external {
        token.transfer(to, token.balanceOf(address(this)));
    }

    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata
    ) external {
        if (msg.sender != _pool) revert NotPool();
        if (amount0Owed > 0) {
            IERC20(IUniswapV3PoolSeed(msg.sender).token0()).transfer(msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            IERC20(IUniswapV3PoolSeed(msg.sender).token1()).transfer(msg.sender, amount1Owed);
        }
    }

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external {
        if (msg.sender != _pool) revert NotPool();
        if (amount0Delta > 0) {
            IERC20(IUniswapV3PoolSeed(msg.sender).token0()).transfer(
                msg.sender,
                uint256(amount0Delta)
            );
        }
        if (amount1Delta > 0) {
            IERC20(IUniswapV3PoolSeed(msg.sender).token1()).transfer(
                msg.sender,
                uint256(amount1Delta)
            );
        }
    }
}
