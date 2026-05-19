// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title UserRegistry — wallet ↔ (identifier, nickname) bookkeeping for ranked accounts.
/// @notice Owner (server submitter) records ranked players on-chain. Identifier is an opaque
///         keccak256 hash of the off-chain login id (currently lowered email); only the hash
///         is stored. Nicknames are unique case-insensitively across ASCII A–Z.
contract UserRegistry is Ownable {
    struct User {
        bytes32 identifier;
        string nickname;
    }

    mapping(address => User) public users;
    mapping(bytes32 => address) public nicknameOwner;

    uint256 public constant NICKNAME_MIN_BYTES = 2;
    uint256 public constant NICKNAME_MAX_BYTES = 18;

    error InvalidWallet();
    error InvalidIdentifier();
    error InvalidNicknameLength();
    error AlreadyRegistered();
    error NicknameTaken();
    error NotRegistered();

    event UserRegistered(address indexed wallet, bytes32 indexed identifier, string nickname);
    event NicknameUpdated(address indexed wallet, string nickname);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function register(address wallet, bytes32 identifier, string memory nickname)
        external
        onlyOwner
    {
        if (wallet == address(0)) revert InvalidWallet();
        if (identifier == bytes32(0)) revert InvalidIdentifier();
        _validateNicknameLength(nickname);
        if (users[wallet].identifier != bytes32(0)) revert AlreadyRegistered();

        bytes32 nickKey = _nickKey(nickname);
        if (nicknameOwner[nickKey] != address(0)) revert NicknameTaken();

        users[wallet] = User({identifier: identifier, nickname: nickname});
        nicknameOwner[nickKey] = wallet;

        emit UserRegistered(wallet, identifier, nickname);
    }

    function updateNickname(address wallet, string memory newNickname) external onlyOwner {
        User storage u = users[wallet];
        if (u.identifier == bytes32(0)) revert NotRegistered();
        _validateNicknameLength(newNickname);

        bytes32 newKey = _nickKey(newNickname);
        address currentHolder = nicknameOwner[newKey];
        if (currentHolder != address(0) && currentHolder != wallet) revert NicknameTaken();

        bytes32 oldKey = _nickKey(u.nickname);
        if (oldKey != newKey) {
            delete nicknameOwner[oldKey];
            nicknameOwner[newKey] = wallet;
        }

        u.nickname = newNickname;
        emit NicknameUpdated(wallet, newNickname);
    }

    function lookupByWallet(address wallet) external view returns (User memory) {
        return users[wallet];
    }

    function isNicknameFree(string memory nickname) external view returns (bool) {
        return nicknameOwner[_nickKey(nickname)] == address(0);
    }

    function _validateNicknameLength(string memory nickname) internal pure {
        uint256 len = bytes(nickname).length;
        if (len < NICKNAME_MIN_BYTES || len > NICKNAME_MAX_BYTES) {
            revert InvalidNicknameLength();
        }
    }

    /// @dev Lower-cases ASCII A–Z then keccak256s. Non-ASCII bytes pass through unchanged so
    ///      Unicode nicknames keep byte-exact uniqueness; server is expected to enforce the
    ///      finer character policy.
    function _nickKey(string memory nickname) internal pure returns (bytes32) {
        bytes memory raw = bytes(nickname);
        bytes memory lower = new bytes(raw.length);
        for (uint256 i = 0; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            if (c >= 0x41 && c <= 0x5A) {
                lower[i] = bytes1(c + 32);
            } else {
                lower[i] = raw[i];
            }
        }
        return keccak256(lower);
    }
}
