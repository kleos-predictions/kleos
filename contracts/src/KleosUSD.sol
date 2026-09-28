// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KleosUSD
/// @notice Test stablecoin for the Kleos testnet demo. Anyone can mint from the faucet
///         once per cooldown, and the sponsor can top up new passkey accounts so the first
///         bet needs no extra step. 6 decimals, like USDC.
contract KleosUSD {
    string public constant name = "Kleos Test USD";
    string public constant symbol = "kUSD";
    uint8 public constant decimals = 6;

    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    uint256 public constant SPONSOR_MINT_MAX = 1_000e6;

    address public owner;
    address public sponsor;
    /// @notice The Kleos market. It can move kUSD without a separate approval, so a new account's
    ///         first bet is one transaction. Fine for a test token; a real stablecoin needs approvals.
    address public market;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public lastFaucet;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error FaucetCooldown(uint256 availableAt);
    error NotOwner();
    error NotSponsor();
    error MintTooLarge();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor() {
        owner = msg.sender;
        sponsor = msg.sender;
    }

    function setSponsor(address next) external {
        if (msg.sender != owner) revert NotOwner();
        sponsor = next;
    }

    function setMarket(address next) external {
        if (msg.sender != owner) revert NotOwner();
        market = next;
    }

    /// @notice Test money for a new account, sent by the app's sponsor wallet.
    function sponsorMint(address to, uint256 value) external {
        if (msg.sender != sponsor) revert NotSponsor();
        if (value > SPONSOR_MINT_MAX) revert MintTooLarge();
        _mint(to, value);
    }

    function faucet() external {
        uint256 availableAt = lastFaucet[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucet[msg.sender] != 0 && block.timestamp < availableAt) revert FaucetCooldown(availableAt);
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (msg.sender != market && allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (balanceOf[from] < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] -= value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
}
