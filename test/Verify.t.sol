// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {Test} from "forge-std/Test.sol";
import {SqueekBet, ISqueekCore, IERC20} from "../src/SqueekBet.sol";

/// Redeploys our source from the same deployer on a fork and compares runtime bytecode.
contract VerifyDeployment is Test {
    function test_deployedCodeMatchesSource() public {
        address deployed = vm.envOr("DEPLOYED", address(0));
        if (deployed == address(0)) return; // only runs when verifying a live deployment
        vm.createSelectFork(vm.envString("SEPOLIA_RPC"));
        address deployer = vm.envAddress("DEPLOYER");
        vm.prank(deployer);
        SqueekBet ours = new SqueekBet(
            ISqueekCore(0x980B4424c007CAf7a1f3670B48c8EaEf7EbC3d44),
            IERC20(0x6872BfA5CcC3E9e440C6c16e5fFdAbb8DBA4Cc76)
        );
        assertEq(keccak256(address(ours).code), keccak256(deployed.code), "runtime bytecode differs");
        emit log_named_bytes32("codehash", keccak256(deployed.code));
    }
}
