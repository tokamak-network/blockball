// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {UserRegistry} from "../src/UserRegistry.sol";

contract UserRegistryTest is Test {
    UserRegistry internal registry;

    address internal constant OWNER = address(0xCAFE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    bytes32 internal constant ALICE_ID = keccak256("alice@example.com");
    bytes32 internal constant BOB_ID = keccak256("bob@example.com");

    event UserRegistered(address indexed wallet, bytes32 indexed identifier, string nickname);
    event NicknameUpdated(address indexed wallet, string nickname);

    function setUp() public {
        registry = new UserRegistry(OWNER);
    }

    // ---------- register ----------

    function test_RegisterHappyPath() public {
        vm.expectEmit(true, true, false, true);
        emit UserRegistered(ALICE, ALICE_ID, "NeonK");

        vm.prank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");

        (bytes32 id, string memory nick) = registry.users(ALICE);
        assertEq(id, ALICE_ID);
        assertEq(nick, "NeonK");

        assertFalse(registry.isNicknameFree("NeonK"));
        assertFalse(registry.isNicknameFree("neonk"));
        assertFalse(registry.isNicknameFree("NEONK"));
        assertTrue(registry.isNicknameFree("Other"));
        assertEq(registry.nicknameOwner(keccak256("neonk")), ALICE);
    }

    function test_RevertOnZeroWallet() public {
        vm.prank(OWNER);
        vm.expectRevert(UserRegistry.InvalidWallet.selector);
        registry.register(address(0), ALICE_ID, "NeonK");
    }

    function test_RevertOnZeroIdentifier() public {
        vm.prank(OWNER);
        vm.expectRevert(UserRegistry.InvalidIdentifier.selector);
        registry.register(ALICE, bytes32(0), "NeonK");
    }

    function test_RevertOnShortNickname() public {
        vm.prank(OWNER);
        vm.expectRevert(UserRegistry.InvalidNicknameLength.selector);
        registry.register(ALICE, ALICE_ID, "A");
    }

    function test_RevertOnLongNickname() public {
        // 19 bytes — one over the 18-byte cap.
        vm.prank(OWNER);
        vm.expectRevert(UserRegistry.InvalidNicknameLength.selector);
        registry.register(ALICE, ALICE_ID, "1234567890123456789");
    }

    function test_RevertOnAlreadyRegistered() public {
        vm.startPrank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");
        vm.expectRevert(UserRegistry.AlreadyRegistered.selector);
        registry.register(ALICE, ALICE_ID, "OtherNick");
        vm.stopPrank();
    }

    function test_RevertOnDuplicateNickname() public {
        vm.startPrank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");
        vm.expectRevert(UserRegistry.NicknameTaken.selector);
        registry.register(BOB, BOB_ID, "NeonK");
        vm.stopPrank();
    }

    function test_RevertOnDuplicateNicknameCaseInsensitive() public {
        vm.startPrank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");
        vm.expectRevert(UserRegistry.NicknameTaken.selector);
        registry.register(BOB, BOB_ID, "NEONK");
        vm.stopPrank();
    }

    function test_RevertOnNonOwnerRegister() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, ALICE));
        vm.prank(ALICE);
        registry.register(ALICE, ALICE_ID, "NeonK");
    }

    // ---------- updateNickname ----------

    function test_UpdateNicknameHappyPath() public {
        vm.startPrank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");

        vm.expectEmit(true, false, false, true);
        emit NicknameUpdated(ALICE, "NewNick");
        registry.updateNickname(ALICE, "NewNick");
        vm.stopPrank();

        (, string memory nick) = registry.users(ALICE);
        assertEq(nick, "NewNick");
        assertTrue(registry.isNicknameFree("NeonK"));
        assertFalse(registry.isNicknameFree("NewNick"));
    }

    function test_RevertUpdateNicknameNotRegistered() public {
        vm.prank(OWNER);
        vm.expectRevert(UserRegistry.NotRegistered.selector);
        registry.updateNickname(ALICE, "NewNick");
    }

    function test_RevertUpdateNicknameTakenByOther() public {
        vm.startPrank(OWNER);
        registry.register(ALICE, ALICE_ID, "AliceNick");
        registry.register(BOB, BOB_ID, "BobNick");
        vm.expectRevert(UserRegistry.NicknameTaken.selector);
        registry.updateNickname(ALICE, "BobNick");
        vm.stopPrank();
    }

    function test_UpdateNicknameCaseChangeAllowed() public {
        vm.startPrank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");
        // Same case-insensitive key — caller already owns it, should succeed.
        registry.updateNickname(ALICE, "NEONK");
        vm.stopPrank();

        (, string memory nick) = registry.users(ALICE);
        assertEq(nick, "NEONK");
        assertEq(registry.nicknameOwner(keccak256("neonk")), ALICE);
    }

    function test_RevertUpdateNicknameLengthInvalid() public {
        vm.startPrank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");
        vm.expectRevert(UserRegistry.InvalidNicknameLength.selector);
        registry.updateNickname(ALICE, "A");
        vm.stopPrank();
    }

    function test_RevertOnNonOwnerUpdate() public {
        vm.prank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BOB));
        vm.prank(BOB);
        registry.updateNickname(ALICE, "Other");
    }

    // ---------- views ----------

    function test_LookupByWallet() public {
        vm.prank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");

        UserRegistry.User memory u = registry.lookupByWallet(ALICE);
        assertEq(u.identifier, ALICE_ID);
        assertEq(u.nickname, "NeonK");

        UserRegistry.User memory empty = registry.lookupByWallet(BOB);
        assertEq(empty.identifier, bytes32(0));
        assertEq(bytes(empty.nickname).length, 0);
    }

    function test_IsNicknameFree() public {
        assertTrue(registry.isNicknameFree("Anything"));

        vm.prank(OWNER);
        registry.register(ALICE, ALICE_ID, "NeonK");

        assertFalse(registry.isNicknameFree("NeonK"));
        assertFalse(registry.isNicknameFree("neonk"));
        assertFalse(registry.isNicknameFree("NEONK"));
        assertTrue(registry.isNicknameFree("OtherNick"));
    }
}
