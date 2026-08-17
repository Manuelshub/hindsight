// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LineageRegistry} from "../src/LineageRegistry.sol";

contract LineageRegistryTest is Test {
    LineageRegistry internal registry;

    bytes32 internal constant LINEAGE = keccak256("hindsight/BTCUSDT-1h");
    address internal author = address(0xA11CE);
    address internal stranger = address(0xB0B);

    bytes32 internal constant DATASET = bytes32(uint256(0xDA7A));
    bytes32 internal constant ADAPTER = bytes32(uint256(0xADA9));
    bytes32 internal constant CONFIG = bytes32(uint256(0xC0F1));
    bytes32 internal constant TRACES = bytes32(uint256(0x77ACE));

    function setUp() public {
        registry = new LineageRegistry();
        // Start well past the epoch so `trainDataEnd` in the past is expressible.
        vm.warp(1_800_000_000);
        vm.prank(author);
        registry.createLineage(LINEAGE);
    }

    // --- helpers -------------------------------------------------------------

    function _sealRoot() internal returns (uint64 sealedAt) {
        vm.prank(author);
        registry.sealGeneration(
            LINEAGE, 0, 0, DATASET, ADAPTER, CONFIG, uint64(block.timestamp - 1 days)
        );
        return uint64(block.timestamp);
    }

    // --- lineage -------------------------------------------------------------

    function test_createLineage_setsAuthor() public view {
        LineageRegistry.Lineage memory lineage = registry.getLineage(LINEAGE);
        assertEq(lineage.author, author);
        assertTrue(lineage.exists);
    }

    function test_createLineage_revertsOnDuplicate() public {
        vm.prank(author);
        vm.expectRevert(LineageRegistry.LineageExists.selector);
        registry.createLineage(LINEAGE);
    }

    function test_sealGeneration_revertsForUnknownLineage() public {
        vm.prank(author);
        vm.expectRevert(LineageRegistry.UnknownLineage.selector);
        registry.sealGeneration(keccak256("nope"), 0, 0, DATASET, ADAPTER, CONFIG, 0);
    }

    function test_sealGeneration_revertsForStranger() public {
        vm.prank(stranger);
        vm.expectRevert(LineageRegistry.NotAuthor.selector);
        registry.sealGeneration(LINEAGE, 0, 0, DATASET, ADAPTER, CONFIG, 0);
    }

    // --- sealing -------------------------------------------------------------

    function test_sealGeneration_storesCommitment() public {
        uint64 sealedAt = _sealRoot();

        LineageRegistry.Generation memory generation = registry.getGeneration(LINEAGE, 0);
        assertEq(generation.datasetRoot, DATASET);
        assertEq(generation.adapterRoot, ADAPTER);
        assertEq(generation.configHash, CONFIG);
        assertEq(generation.sealedAt, sealedAt);
        assertEq(registry.latestGeneration(LINEAGE), 0);
    }

    /// @dev I3 — storage is write-once, including for the author.
    function test_sealGeneration_isWriteOnce() public {
        _sealRoot();
        vm.prank(author);
        vm.expectRevert(LineageRegistry.GenerationExists.selector);
        registry.sealGeneration(LINEAGE, 0, 0, DATASET, ADAPTER, CONFIG, 0);
    }

    function test_sealGeneration_requiresSealedParent() public {
        _sealRoot();
        vm.prank(author);
        vm.expectRevert(LineageRegistry.UnknownParent.selector);
        // parent 7 was never sealed
        registry.sealGeneration(LINEAGE, 1, 7, DATASET, ADAPTER, CONFIG, 0);
    }

    function test_sealGeneration_chainsFromParent() public {
        _sealRoot();
        vm.prank(author);
        registry.sealGeneration(
            LINEAGE, 1, 0, DATASET, ADAPTER, CONFIG, uint64(block.timestamp - 1 hours)
        );
        assertEq(registry.getGeneration(LINEAGE, 1).parent, 0);
        assertEq(registry.latestGeneration(LINEAGE), 1);
    }

    function test_sealGeneration_rejectsFutureTrainingData() public {
        vm.prank(author);
        vm.expectRevert(LineageRegistry.TrainDataInFuture.selector);
        registry.sealGeneration(
            LINEAGE, 0, 0, DATASET, ADAPTER, CONFIG, uint64(block.timestamp + 1)
        );
    }

    // --- evaluation: the invariant this contract exists for ------------------

    /// @dev I2. If this test ever passes with a smaller `windowStart`, every performance
    ///      number the project reports becomes an unverifiable backtest.
    function test_recordEvaluation_revertsWhenWindowPredatesSeal() public {
        uint64 sealedAt = _sealRoot();

        vm.prank(author);
        vm.expectRevert(LineageRegistry.EvaluationPredatesSeal.selector);
        registry.recordEvaluation(
            LINEAGE, 0, sealedAt - 1, sealedAt + 1 days, 100, 5000, 12, 340, TRACES
        );
    }

    function test_recordEvaluation_acceptsWindowStartingExactlyAtSeal() public {
        uint64 sealedAt = _sealRoot();

        vm.prank(author);
        registry.recordEvaluation(
            LINEAGE, 0, sealedAt, sealedAt + 1 days, 100, 5000, 12, 340, TRACES
        );
        assertEq(registry.evaluationCount(LINEAGE, 0), 1);
    }

    function testFuzz_recordEvaluation_revertsForAnyPreSealWindow(uint64 offset) public {
        uint64 sealedAt = _sealRoot();
        offset = uint64(bound(offset, 1, sealedAt));

        vm.prank(author);
        vm.expectRevert(LineageRegistry.EvaluationPredatesSeal.selector);
        registry.recordEvaluation(
            LINEAGE, 0, sealedAt - offset, sealedAt + 1 days, 100, 5000, 12, 340, TRACES
        );
    }

    function test_recordEvaluation_storesResults() public {
        uint64 sealedAt = _sealRoot();
        vm.warp(block.timestamp + 3 days);

        vm.prank(author);
        registry.recordEvaluation(
            LINEAGE, 0, sealedAt + 1 hours, sealedAt + 2 days, 736, 4812, -3, -150, TRACES
        );

        LineageRegistry.Evaluation[] memory evaluations = registry.getEvaluations(LINEAGE, 0);
        assertEq(evaluations.length, 1);
        assertEq(evaluations[0].decisions, 736);
        assertEq(evaluations[0].accuracyBps, 4812);
        assertEq(evaluations[0].meanReturnBps, -3);
        assertEq(evaluations[0].cumulativeReturnBps, -150);
        assertEq(evaluations[0].traceRoot, TRACES);
    }

    function test_recordEvaluation_accumulatesAcrossWindows() public {
        uint64 sealedAt = _sealRoot();
        vm.startPrank(author);
        registry.recordEvaluation(LINEAGE, 0, sealedAt, sealedAt + 1 days, 10, 5000, 1, 2, TRACES);
        registry.recordEvaluation(
            LINEAGE, 0, sealedAt + 1 days, sealedAt + 2 days, 10, 5100, 1, 3, TRACES
        );
        vm.stopPrank();
        assertEq(registry.evaluationCount(LINEAGE, 0), 2);
    }

    function test_recordEvaluation_revertsForUnsealedGeneration() public {
        vm.prank(author);
        vm.expectRevert(LineageRegistry.UnknownGeneration.selector);
        registry.recordEvaluation(
            LINEAGE, 3, uint64(block.timestamp), uint64(block.timestamp + 1), 1, 1, 0, 0, TRACES
        );
    }

    function test_recordEvaluation_revertsForEmptyWindow() public {
        uint64 sealedAt = _sealRoot();
        vm.prank(author);
        vm.expectRevert(LineageRegistry.EmptyWindow.selector);
        registry.recordEvaluation(LINEAGE, 0, sealedAt + 10, sealedAt + 10, 1, 1, 0, 0, TRACES);
    }

    function test_recordEvaluation_revertsForZeroDecisions() public {
        uint64 sealedAt = _sealRoot();
        vm.prank(author);
        vm.expectRevert(LineageRegistry.NoDecisions.selector);
        registry.recordEvaluation(LINEAGE, 0, sealedAt, sealedAt + 1 days, 0, 1, 0, 0, TRACES);
    }

    function test_recordEvaluation_revertsForImpossibleAccuracy() public {
        uint64 sealedAt = _sealRoot();
        vm.prank(author);
        vm.expectRevert(LineageRegistry.AccuracyOutOfRange.selector);
        registry.recordEvaluation(
            LINEAGE, 0, sealedAt, sealedAt + 1 days, 10, 10_001, 0, 0, TRACES
        );
    }

    function test_recordEvaluation_revertsForStranger() public {
        uint64 sealedAt = _sealRoot();
        vm.prank(stranger);
        vm.expectRevert(LineageRegistry.NotAuthor.selector);
        registry.recordEvaluation(LINEAGE, 0, sealedAt, sealedAt + 1 days, 10, 5000, 0, 0, TRACES);
    }

    function test_getGeneration_revertsForUnknown() public {
        vm.expectRevert(LineageRegistry.UnknownGeneration.selector);
        registry.getGeneration(LINEAGE, 9);
    }
}
