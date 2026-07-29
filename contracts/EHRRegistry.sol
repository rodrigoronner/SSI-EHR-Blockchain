// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// @title EHRRegistry
/// @notice On-chain DID registry for patients, physicians, and hospitals.
/// Implements the same interface as ERC-1056's EthereumDIDRegistry, so
/// standard ethr-did / ethr-did-resolver tooling resolves identities here
/// without any custom resolver.
/// @dev Attribute values are never written to storage, only emitted as
/// events; a DID Document is rebuilt off-chain by walking the event log
/// backwards from `changed[identity]`. Guardian recovery exists because
/// `changeOwner` needs a signature from the current key, which is exactly
/// what you don't have once that key is actually lost.
contract EHRRegistry {
    mapping(address => address) public owners;
    mapping(address => mapping(bytes32 => mapping(address => uint256))) public delegates;
    mapping(address => uint256) public changed;

    mapping(address => address[]) public guardians;
    mapping(address => uint256) public recoveryThreshold;
    // identity => proposedNewOwner => guardian => already approved?
    mapping(address => mapping(address => mapping(address => bool))) public recoveryApprovals;
    // identity => proposedNewOwner => number of distinct guardian approvals so far
    mapping(address => mapping(address => uint256)) public recoveryApprovalCount;

    event DIDOwnerChanged(address indexed identity, address owner, uint256 previousChange);

    event DIDDelegateChanged(
        address indexed identity,
        bytes32 delegateType,
        address delegate,
        uint256 validTo,
        uint256 previousChange
    );

    event DIDAttributeChanged(
        address indexed identity,
        bytes32 name,
        bytes value,
        uint256 validTo,
        uint256 previousChange
    );

    event GuardiansConfigured(address indexed identity, address[] guardians, uint256 threshold);

    event RecoveryApproved(
        address indexed identity, address indexed proposedNewOwner, address indexed guardian, uint256 approvalCount
    );

    event RecoveryExecuted(address indexed identity, address newOwner);

    modifier onlyOwner(address identity, address actor) {
        require(actor == identityOwner(identity), "EHRRegistry: not authorized (not identity owner)");
        _;
    }

    /// @notice Resolves the current controller of a DID. Defaults to the
    /// identity's own address (self-sovereign by default) until ownership is
    /// explicitly transferred, e.g. when a hospital entity is acquired.
    function identityOwner(address identity) public view returns (address) {
        address owner = owners[identity];
        if (owner != address(0)) {
            return owner;
        }
        return identity;
    }

    // ---------------------------------------------------------------------
    // Ownership transfer (use case: hospital acquired by a new investor)
    // ---------------------------------------------------------------------

    function _changeOwner(address identity, address actor, address newOwner) internal onlyOwner(identity, actor) {
        owners[identity] = newOwner;
        emit DIDOwnerChanged(identity, newOwner, changed[identity]);
        changed[identity] = block.number;
    }

    function changeOwner(address identity, address newOwner) public {
        _changeOwner(identity, msg.sender, newOwner);
    }

    // ---------------------------------------------------------------------
    // Delegation (use case: parent delegating a minor's identity to a
    // temporary responsible party, with an automatic expiry)
    // ---------------------------------------------------------------------

    function validDelegate(address identity, bytes32 delegateType, address delegate) public view returns (bool) {
        uint256 validity = delegates[identity][keccak256(abi.encodePacked(delegateType))][delegate];
        return validity > block.timestamp;
    }

    function _addDelegate(
        address identity,
        address actor,
        bytes32 delegateType,
        address delegate,
        uint256 validityPeriod
    ) internal onlyOwner(identity, actor) {
        delegates[identity][keccak256(abi.encodePacked(delegateType))][delegate] = block.timestamp + validityPeriod;
        emit DIDDelegateChanged(identity, delegateType, delegate, block.timestamp + validityPeriod, changed[identity]);
        changed[identity] = block.number;
    }

    function addDelegate(address identity, bytes32 delegateType, address delegate, uint256 validityPeriod) public {
        _addDelegate(identity, msg.sender, delegateType, delegate, validityPeriod);
    }

    function _revokeDelegate(address identity, address actor, bytes32 delegateType, address delegate)
        internal
        onlyOwner(identity, actor)
    {
        delegates[identity][keccak256(abi.encodePacked(delegateType))][delegate] = block.timestamp;
        emit DIDDelegateChanged(identity, delegateType, delegate, block.timestamp, changed[identity]);
        changed[identity] = block.number;
    }

    function revokeDelegate(address identity, bytes32 delegateType, address delegate) public {
        _revokeDelegate(identity, msg.sender, delegateType, delegate);
    }

    // ---------------------------------------------------------------------
    // Attributes (use case: publishing a service endpoint URL, or anchoring
    // the hash/CID of an off-chain IPFS-stored, encrypted EHR document)
    // ---------------------------------------------------------------------

    function _setAttribute(address identity, address actor, bytes32 name, bytes memory value, uint256 validityPeriod)
        internal
        onlyOwner(identity, actor)
    {
        emit DIDAttributeChanged(identity, name, value, block.timestamp + validityPeriod, changed[identity]);
        changed[identity] = block.number;
    }

    function setAttribute(address identity, bytes32 name, bytes memory value, uint256 validityPeriod) public {
        _setAttribute(identity, msg.sender, name, value, validityPeriod);
    }

    function _revokeAttribute(address identity, address actor, bytes32 name, bytes memory value)
        internal
        onlyOwner(identity, actor)
    {
        emit DIDAttributeChanged(identity, name, value, 0, changed[identity]);
        changed[identity] = block.number;
    }

    function revokeAttribute(address identity, bytes32 name, bytes memory value) public {
        _revokeAttribute(identity, msg.sender, name, value);
    }

    // ---------------------------------------------------------------------
    // Guardian-based social recovery (use case: the owner's private key is
    // genuinely lost, and a pre-authorized set of guardians restores access)
    // ---------------------------------------------------------------------

    /// @notice (Re-)configures the guardian set and approval threshold for an
    /// identity. Only the current owner can call this, typically once ahead
    /// of time while they still hold their key, and again after a recovery
    /// since that clears the previous guardian set.
    function setGuardians(address identity, address[] calldata newGuardians, uint256 threshold)
        public
        onlyOwner(identity, msg.sender)
    {
        require(newGuardians.length > 0, "EHRRegistry: at least one guardian required");
        require(threshold > 0 && threshold <= newGuardians.length, "EHRRegistry: invalid threshold");
        for (uint256 i = 0; i < newGuardians.length; i++) {
            require(newGuardians[i] != address(0), "EHRRegistry: guardian cannot be the zero address");
            for (uint256 j = i + 1; j < newGuardians.length; j++) {
                require(newGuardians[i] != newGuardians[j], "EHRRegistry: duplicate guardian");
            }
        }
        guardians[identity] = newGuardians;
        recoveryThreshold[identity] = threshold;
        emit GuardiansConfigured(identity, newGuardians, threshold);
    }

    function isGuardian(address identity, address account) public view returns (bool) {
        address[] storage identityGuardians = guardians[identity];
        for (uint256 i = 0; i < identityGuardians.length; i++) {
            if (identityGuardians[i] == account) {
                return true;
            }
        }
        return false;
    }

    /// @notice A guardian votes to move `identity` to `proposedNewOwner`.
    /// Once enough distinct guardians (>= the configured threshold) have
    /// approved the same proposed address, recovery executes immediately,
    /// with no action needed from the lost key.
    function approveRecovery(address identity, address proposedNewOwner) public {
        require(isGuardian(identity, msg.sender), "EHRRegistry: caller is not a guardian for this identity");
        require(proposedNewOwner != address(0), "EHRRegistry: cannot recover to the zero address");
        require(
            !recoveryApprovals[identity][proposedNewOwner][msg.sender], "EHRRegistry: guardian already approved"
        );

        recoveryApprovals[identity][proposedNewOwner][msg.sender] = true;
        uint256 approvalCount = ++recoveryApprovalCount[identity][proposedNewOwner];
        emit RecoveryApproved(identity, proposedNewOwner, msg.sender, approvalCount);

        if (approvalCount >= recoveryThreshold[identity]) {
            _executeRecovery(identity, proposedNewOwner);
        }
    }

    function _executeRecovery(address identity, address newOwner) internal {
        owners[identity] = newOwner;
        emit DIDOwnerChanged(identity, newOwner, changed[identity]);
        changed[identity] = block.number;
        emit RecoveryExecuted(identity, newOwner);

        // The new owner has to call setGuardians again to re-enable recovery.
        delete guardians[identity];
        delete recoveryThreshold[identity];
    }
}
