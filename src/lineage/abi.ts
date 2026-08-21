/** Generated from contracts/out — regenerate with `forge build` after any change. */
export const LINEAGE_REGISTRY_ABI = [
  {
    "type": "function",
    "name": "createLineage",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "evaluationCount",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getEvaluations",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct LineageRegistry.Evaluation[]",
        "components": [
          {
            "name": "windowStart",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "windowEnd",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "decisions",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "accuracyBps",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "meanReturnBps",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "cumulativeReturnBps",
            "type": "int64",
            "internalType": "int64"
          },
          {
            "name": "traceRoot",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "recordedAt",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getGeneration",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct LineageRegistry.Generation",
        "components": [
          {
            "name": "parent",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "datasetRoot",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "adapterRoot",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "configHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "sealedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "trainDataEnd",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "getLineage",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct LineageRegistry.Lineage",
        "components": [
          {
            "name": "author",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "latest",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "exists",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "latestGeneration",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "recordEvaluation",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "windowStart",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "windowEnd",
        "type": "uint64",
        "internalType": "uint64"
      },
      {
        "name": "decisions",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "accuracyBps",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "meanReturnBps",
        "type": "int64",
        "internalType": "int64"
      },
      {
        "name": "cumulativeReturnBps",
        "type": "int64",
        "internalType": "int64"
      },
      {
        "name": "traceRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "sealGeneration",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "parent",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "datasetRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "adapterRoot",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "configHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "trainDataEnd",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "event",
    "name": "EvaluationRecorded",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "windowStart",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "windowEnd",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      },
      {
        "name": "accuracyBps",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "cumulativeReturnBps",
        "type": "int64",
        "indexed": false,
        "internalType": "int64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "GenerationSealed",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "index",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "parent",
        "type": "uint32",
        "indexed": false,
        "internalType": "uint32"
      },
      {
        "name": "datasetRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "adapterRoot",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "sealedAt",
        "type": "uint64",
        "indexed": false,
        "internalType": "uint64"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "LineageCreated",
    "inputs": [
      {
        "name": "lineageId",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "author",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AccuracyOutOfRange",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EmptyWindow",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EvaluationPredatesSeal",
    "inputs": []
  },
  {
    "type": "error",
    "name": "GenerationExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "LineageExists",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NoDecisions",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotAuthor",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TrainDataInFuture",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownGeneration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownLineage",
    "inputs": []
  },
  {
    "type": "error",
    "name": "UnknownParent",
    "inputs": []
  }
] as const;
