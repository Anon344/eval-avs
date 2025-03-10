// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.9;

interface IHelloWorldServiceManager {
    // EVENTS
    event NewTaskCreated(uint32 indexed taskIndex, Task task);
    event TaskResponded(
        uint32 indexed taskIndex,
        Task task,
        address operator,
        uint256 accuracy
    );

    // STRUCTS
    struct Prompt {
        string question;
        string[] choices;
    }

    struct Task {
        string name;
        Prompt[] prompts;
        uint32 taskCreatedBlock;
    }

    // FUNCTIONS
    function createNewTask(
        string memory name,
        Prompt[] memory prompts
    ) external;

    function respondToTask(
        Task calldata task,
        uint32 referenceTaskIndex,
        bytes calldata signature,
        uint256 accuracy
    ) external;
}
