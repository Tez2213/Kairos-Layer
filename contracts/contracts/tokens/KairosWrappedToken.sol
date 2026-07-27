// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {
    ERC20ToERC7984Wrapper
} from "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";

/**
 * @title KairosWrappedToken
 * @notice Concrete ERC-20 → ERC-7984 confidential wrapper (1:1, same decimals).
 *         Deployed twice: cUSDC (wraps TestUSDC) and cWETH (wraps canonical Sepolia WETH9).
 *         All balance/transfer amounts inside this token are encrypted Nox handles.
 */
contract KairosWrappedToken is ERC20ToERC7984Wrapper {
    constructor(
        string memory name,
        string memory symbol,
        string memory contractURI,
        IERC20 underlying
    ) ERC20ToERC7984Wrapper(name, symbol, contractURI, underlying) {}
}
