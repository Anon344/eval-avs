// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

import "@eigenlayer/contracts/libraries/BytesLib.sol";
import "@eigenlayer/contracts/core/DelegationManager.sol";
import "@eigenlayer-middleware/src/unaudited/ECDSAServiceManagerBase.sol";
import "@eigenlayer-middleware/src/unaudited/ECDSAStakeRegistry.sol";
import "@openzeppelin-upgrades/contracts/utils/cryptography/ECDSAUpgradeable.sol";
import "@eigenlayer/contracts/permissions/Pausable.sol";
import {IRegistryCoordinator} from "@eigenlayer-middleware/src/interfaces/IRegistryCoordinator.sol";
import "./IHelloWorldServiceManager.sol";

contract HelloWorldServiceManager is
    ECDSAServiceManagerBase,
    IHelloWorldServiceManager,
    Pausable
{
    using BytesLib for bytes;
    using ECDSAUpgradeable for bytes32;

    /* STORAGE */
    uint32 public latestTaskNum;
    mapping(uint32 => bytes32) public allTaskHashes;
    mapping(address => mapping(uint32 => bytes)) public allTaskResponses;

    /* MODIFIERS */
    modifier onlyOperator() {
        require(
            ECDSAStakeRegistry(stakeRegistry).operatorRegistered(msg.sender) ==
                true,
            "Operator must be the caller"
        );
        _;
    }

    constructor(
        address _avsDirectory,
        address _stakeRegistry,
        address _delegationManager
    )
        ECDSAServiceManagerBase(
            _avsDirectory,
            _stakeRegistry,
            address(0), // hello-world doesn't need to deal with payments
            _delegationManager
        )
    {}

    function createNewTask(
        string memory name,
        Prompt[] memory prompts
    ) external {
        Task memory newTask;
        newTask.name = name;
        newTask.prompts = prompts;
        newTask.taskCreatedBlock = uint32(block.number);

        allTaskHashes[latestTaskNum] = keccak256(abi.encode(newTask));
        emit NewTaskCreated(latestTaskNum, newTask);
        latestTaskNum = latestTaskNum + 1;
    }

    function respondToTask(
        Task calldata task,
        uint32 referenceTaskIndex,
        bytes calldata signature,
        uint256 accuracy
    ) external onlyOperator {
        require(
            operatorHasMinimumWeight(msg.sender),
            "Operator does not match the weight requirements"
        );
        require(
            keccak256(abi.encode(task)) == allTaskHashes[referenceTaskIndex],
            "Supplied task does not match the one recorded in the contract"
        );
        require(
            allTaskResponses[msg.sender][referenceTaskIndex].length == 0,
            "Operator has already responded to the task"
        );

        bytes32 messageHash = keccak256(
            abi.encodePacked(
                "MMLU subset: ",
                task.name,
                " with ",
                task.prompts.length,
                " prompts, Accuracy: ",
                accuracy
            )
        );
        bytes32 ethSignedMessageHash = messageHash.toEthSignedMessageHash();

        address signer = ethSignedMessageHash.recover(signature);

        require(signer == msg.sender, "Message signer is not operator");

        allTaskResponses[msg.sender][referenceTaskIndex] = signature;

        emit TaskResponded(referenceTaskIndex, task, msg.sender, accuracy);
    }

    function operatorHasMinimumWeight(
        address operator
    ) public view returns (bool) {
        return
            ECDSAStakeRegistry(stakeRegistry).getOperatorWeight(operator) >=
            ECDSAStakeRegistry(stakeRegistry).minimumWeight();
    }
}
