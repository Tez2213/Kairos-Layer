// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @notice Minimal Uniswap V3 pool interface — only what KairosPool needs.
/// We swap directly against the pool rather than through the periphery router:
/// one fewer hop, no periphery dependency, and the callback lets us pay from
/// contract-held funds without an intermediate approval.
interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function liquidity() external view returns (uint128);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Time-weighted oracle accumulators. Reverts if the pool lacks
    /// observation history covering `secondsAgos`.
    function observe(
        uint32[] calldata secondsAgos
    )
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128);

    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;

    /// @notice Exact-input/-output swap. Positive amountSpecified = exact input.
    /// Caller must implement IUniswapV3SwapCallback and pay the input there.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IUniswapV3SwapCallback {
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external;
}
