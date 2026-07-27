// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title TestUSDC
 * @notice 6-decimal test stablecoin with an open faucet, used as the public quote asset
 *         on Sepolia. The per-call faucet cap keeps total supply far below 2^128 so
 *         encrypted pro-rata math in KairosPool can never overflow.
 */
contract TestUSDC is ERC20 {
    error Kairos_FaucetCapExceeded();

    /// @notice Max mint per faucet call: 1,000,000 tUSDC.
    uint256 public constant FAUCET_CAP = 1_000_000e6;

    constructor() ERC20("Kairos Test USD", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open testnet faucet.
    function faucet(uint256 amount) external {
        if (amount > FAUCET_CAP) revert Kairos_FaucetCapExceeded();
        _mint(msg.sender, amount);
    }
}
