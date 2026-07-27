// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestWETH
 * @notice 18-decimal WETH stand-in for LOCAL testing only. On Sepolia the pool uses
 *         the canonical WETH9 (0xfff9976782d46cc05630d1f6ebab18b2324d6b14).
 */
contract TestWETH is ERC20 {
    error Kairos_FaucetCapExceeded();

    /// @notice Max mint per faucet call: 1,000 WETH.
    uint256 public constant FAUCET_CAP = 1_000e18;

    constructor() ERC20("Kairos Test WETH", "tWETH") {}

    function faucet(uint256 amount) external {
        if (amount > FAUCET_CAP) revert Kairos_FaucetCapExceeded();
        _mint(msg.sender, amount);
    }
}
