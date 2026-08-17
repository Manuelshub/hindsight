// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title LineageRegistry
/// @notice Tamper-evident record of a self-improving agent's generations and their
///         out-of-sample performance.
///
/// @dev The contract exists for exactly one reason: to make "this model improved" a
///      checkable claim rather than an assertion.
///
///      A generation is *sealed* — its training data, weights and config committed by
///      hash — at a public block timestamp. It may then only be graded on market data
///      that closed *after* that timestamp. `recordEvaluation` enforces this. Without
///      that single check, every number this project reports would be an unverifiable
///      backtest, which is precisely the thing the project exists to avoid.
///
///      Storage is write-once. Nothing here can be revised after the fact, including
///      by the author.
contract LineageRegistry {
    /// @notice A sealed generation of the agent.
    /// @param parent        index of the generation this was trained from
    /// @param datasetRoot   0G Storage Merkle root of the training set (JSONL)
    /// @param adapterRoot   0G Storage Merkle root of the LoRA adapter
    /// @param configHash    keccak256 over training config, feature version, renderer version
    /// @param sealedAt      block timestamp at seal — the commitment moment
    /// @param trainDataEnd  close time of the newest bar in the training set
    struct Generation {
        uint32 parent;
        bytes32 datasetRoot;
        bytes32 adapterRoot;
        bytes32 configHash;
        uint64 sealedAt;
        uint64 trainDataEnd;
    }

    /// @notice One out-of-sample evaluation of a sealed generation.
    /// @dev Returns are signed basis points; accuracy is unsigned bps (0..10000).
    struct Evaluation {
        uint64 windowStart;
        uint64 windowEnd;
        uint32 decisions;
        uint32 accuracyBps;
        int64 meanReturnBps;
        int64 cumulativeReturnBps;
        bytes32 traceRoot;
        uint64 recordedAt;
    }

    struct Lineage {
        address author;
        uint32 latest;
        bool exists;
    }

    mapping(bytes32 => Lineage) private _lineages;
    mapping(bytes32 => mapping(uint32 => Generation)) private _generations;
    mapping(bytes32 => mapping(uint32 => Evaluation[])) private _evaluations;

    event LineageCreated(bytes32 indexed lineageId, address indexed author);

    event GenerationSealed(
        bytes32 indexed lineageId,
        uint32 indexed index,
        uint32 parent,
        bytes32 datasetRoot,
        bytes32 adapterRoot,
        uint64 sealedAt
    );

    event EvaluationRecorded(
        bytes32 indexed lineageId,
        uint32 indexed index,
        uint64 windowStart,
        uint64 windowEnd,
        uint32 accuracyBps,
        int64 cumulativeReturnBps
    );

    error LineageExists();
    error UnknownLineage();
    error NotAuthor();
    error GenerationExists();
    error UnknownGeneration();
    error UnknownParent();
    error TrainDataInFuture();
    /// @dev The invariant that gives this contract its purpose.
    error EvaluationPredatesSeal();
    error EmptyWindow();
    error NoDecisions();
    error AccuracyOutOfRange();

    /// @notice Registers a new lineage owned by the caller.
    function createLineage(bytes32 lineageId) external {
        if (_lineages[lineageId].exists) revert LineageExists();
        _lineages[lineageId] = Lineage({author: msg.sender, latest: 0, exists: true});
        emit LineageCreated(lineageId, msg.sender);
    }

    /// @notice Commits a generation. Irreversible.
    /// @dev Seals before evaluation exists; that ordering is the whole point.
    function sealGeneration(
        bytes32 lineageId,
        uint32 index,
        uint32 parent,
        bytes32 datasetRoot,
        bytes32 adapterRoot,
        bytes32 configHash,
        uint64 trainDataEnd
    ) external {
        Lineage storage lineage = _lineages[lineageId];
        if (!lineage.exists) revert UnknownLineage();
        if (lineage.author != msg.sender) revert NotAuthor();

        if (_generations[lineageId][index].sealedAt != 0) revert GenerationExists();

        // Every generation except the root must descend from something already sealed,
        // so a lineage is always a connected chain back to its origin.
        if (index != 0 && _generations[lineageId][parent].sealedAt == 0) revert UnknownParent();

        // Training data cannot come from the future.
        if (trainDataEnd > block.timestamp) revert TrainDataInFuture();

        _generations[lineageId][index] = Generation({
            parent: parent,
            datasetRoot: datasetRoot,
            adapterRoot: adapterRoot,
            configHash: configHash,
            sealedAt: uint64(block.timestamp),
            trainDataEnd: trainDataEnd
        });

        if (index > lineage.latest) lineage.latest = index;

        emit GenerationSealed(
            lineageId, index, parent, datasetRoot, adapterRoot, uint64(block.timestamp)
        );
    }

    /// @notice Records how a sealed generation performed on data it could not have seen.
    /// @dev Reverts unless the evaluation window begins at or after the seal. This is the
    ///      line that turns a self-reported backtest into a verifiable claim.
    function recordEvaluation(
        bytes32 lineageId,
        uint32 index,
        uint64 windowStart,
        uint64 windowEnd,
        uint32 decisions,
        uint32 accuracyBps,
        int64 meanReturnBps,
        int64 cumulativeReturnBps,
        bytes32 traceRoot
    ) external {
        Lineage storage lineage = _lineages[lineageId];
        if (!lineage.exists) revert UnknownLineage();
        if (lineage.author != msg.sender) revert NotAuthor();

        Generation storage generation = _generations[lineageId][index];
        if (generation.sealedAt == 0) revert UnknownGeneration();

        if (windowStart < generation.sealedAt) revert EvaluationPredatesSeal();
        if (windowEnd <= windowStart) revert EmptyWindow();
        if (decisions == 0) revert NoDecisions();
        if (accuracyBps > 10_000) revert AccuracyOutOfRange();

        _evaluations[lineageId][index].push(
            Evaluation({
                windowStart: windowStart,
                windowEnd: windowEnd,
                decisions: decisions,
                accuracyBps: accuracyBps,
                meanReturnBps: meanReturnBps,
                cumulativeReturnBps: cumulativeReturnBps,
                traceRoot: traceRoot,
                recordedAt: uint64(block.timestamp)
            })
        );

        emit EvaluationRecorded(
            lineageId, index, windowStart, windowEnd, accuracyBps, cumulativeReturnBps
        );
    }

    function getLineage(bytes32 lineageId) external view returns (Lineage memory) {
        return _lineages[lineageId];
    }

    function getGeneration(bytes32 lineageId, uint32 index)
        external
        view
        returns (Generation memory)
    {
        Generation memory generation = _generations[lineageId][index];
        if (generation.sealedAt == 0) revert UnknownGeneration();
        return generation;
    }

    function getEvaluations(bytes32 lineageId, uint32 index)
        external
        view
        returns (Evaluation[] memory)
    {
        return _evaluations[lineageId][index];
    }

    function evaluationCount(bytes32 lineageId, uint32 index) external view returns (uint256) {
        return _evaluations[lineageId][index].length;
    }

    function latestGeneration(bytes32 lineageId) external view returns (uint32) {
        if (!_lineages[lineageId].exists) revert UnknownLineage();
        return _lineages[lineageId].latest;
    }
}
