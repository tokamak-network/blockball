// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {UserRegistry} from "../src/UserRegistry.sol";

/// @notice Deploys UserRegistry. Reads:
///   - DEPLOYER_PRIVATE_KEY (uint256) — signer that broadcasts the tx
///   - INITIAL_OWNER        (address, optional) — owner of UserRegistry; defaults to the
///                                                deployer address if unset
contract DeployUserRegistry is Script {
    function run() external returns (UserRegistry registry) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address initialOwner = vm.envOr("INITIAL_OWNER", deployer);

        console2.log("Deployer:", deployer);
        console2.log("Initial owner:", initialOwner);

        vm.startBroadcast(deployerKey);
        registry = new UserRegistry(initialOwner);
        vm.stopBroadcast();

        console2.log("UserRegistry deployed at:", address(registry));
    }
}
