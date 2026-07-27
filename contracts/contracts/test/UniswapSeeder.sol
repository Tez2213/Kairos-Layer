// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

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
 * @notice TEST-ONLY helper: provides the mint callback Uniswap V3 requires so local
 *         test pools can be seeded with liquidity without the periphery contracts.
 *         Fund this contract with both tokens, then call `seed`.
 */
contract UniswapSeeder {
    error NotPool();

    address private _pool;

    function seed(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        _pool = pool;
        IUniswapV3PoolSeed(pool).mint(address(this), tickLower, tickUpper, liquidity, "");
        _pool = address(0);
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
}
