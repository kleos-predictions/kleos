// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KleosSocial
/// @notice Usernames, who follows whom, and ups/downs on calls. On-chain, so the graph follows the passkey to any device
///         and anyone can read it. Kept apart from the market contract on purpose: social
///         features can evolve without touching money or reputation.
contract KleosSocial {
    mapping(address => address[]) internal _following;
    mapping(address => mapping(address => uint256)) internal _slot; // index + 1; 0 = not following
    mapping(address => uint256) public followerCount;

    // Usernames: 3–20 chars of a–z, 0–9 and _, unique. Changing yours frees the old one.
    mapping(address => string) public nameOf;
    mapping(bytes32 => address) public ownerOfName;

    // Call votes: engagement only, one vote per address per call. A call's id is
    // keccak256(abi.encode(txHash, logIndex)) of its CallPosted event.
    mapping(bytes32 => uint256) public ups;
    mapping(bytes32 => uint256) public downs;
    mapping(bytes32 => mapping(address => int8)) public voteOf;

    event Followed(address indexed follower, address indexed followee);
    event Unfollowed(address indexed follower, address indexed followee);
    event CallVoted(bytes32 indexed callId, address indexed voter, int8 vote);
    event NameSet(address indexed user, string name);

    error CannotFollowSelf();
    error BadVote();
    error BadName();
    error NameTaken();

    function setName(string calldata name) external {
        bytes memory b = bytes(name);
        if (b.length < 3 || b.length > 20) revert BadName();
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (!((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c == 0x5f)) revert BadName(); // a-z 0-9 _
        }
        bytes32 key = keccak256(b);
        address owner = ownerOfName[key];
        if (owner == msg.sender) return;
        if (owner != address(0)) revert NameTaken();
        string memory old = nameOf[msg.sender];
        if (bytes(old).length > 0) delete ownerOfName[keccak256(bytes(old))];
        ownerOfName[key] = msg.sender;
        nameOf[msg.sender] = name;
        emit NameSet(msg.sender, name);
    }

    /// @notice Usernames for many addresses at once ("" when unset).
    function namesOf(address[] calldata users) external view returns (string[] memory names) {
        names = new string[](users.length);
        for (uint256 i; i < users.length; ++i) names[i] = nameOf[users[i]];
    }

    /// @notice +1 up, -1 down, 0 clears your vote.
    function vote(bytes32 callId, int8 value) external {
        if (value < -1 || value > 1) revert BadVote();
        int8 previous = voteOf[callId][msg.sender];
        if (previous == value) return;
        if (previous == 1) ups[callId]--;
        if (previous == -1) downs[callId]--;
        if (value == 1) ups[callId]++;
        if (value == -1) downs[callId]++;
        voteOf[callId][msg.sender] = value;
        emit CallVoted(callId, msg.sender, value);
    }

    /// @notice Tallies for many calls at once, plus `voter`'s own vote on each (0 if none).
    function tallies(bytes32[] calldata callIds, address voter)
        external
        view
        returns (uint256[] memory up, uint256[] memory down, int8[] memory mine)
    {
        up = new uint256[](callIds.length);
        down = new uint256[](callIds.length);
        mine = new int8[](callIds.length);
        for (uint256 i; i < callIds.length; ++i) {
            up[i] = ups[callIds[i]];
            down[i] = downs[callIds[i]];
            mine[i] = voteOf[callIds[i]][voter];
        }
    }

    function follow(address who) external {
        if (who == msg.sender) revert CannotFollowSelf();
        if (_slot[msg.sender][who] != 0) return;
        _following[msg.sender].push(who);
        _slot[msg.sender][who] = _following[msg.sender].length;
        followerCount[who]++;
        emit Followed(msg.sender, who);
    }

    function unfollow(address who) external {
        uint256 slot = _slot[msg.sender][who];
        if (slot == 0) return;
        address[] storage list = _following[msg.sender];
        address last = list[list.length - 1];
        list[slot - 1] = last;
        _slot[msg.sender][last] = slot;
        list.pop();
        delete _slot[msg.sender][who];
        followerCount[who]--;
        emit Unfollowed(msg.sender, who);
    }

    function isFollowing(address follower, address who) external view returns (bool) {
        return _slot[follower][who] != 0;
    }

    function following(address follower) external view returns (address[] memory) {
        return _following[follower];
    }
}
