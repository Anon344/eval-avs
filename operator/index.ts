import axios from "axios";
import dotenv from "dotenv";
import { ethers } from "ethers";
import https from "https";

import { avsDirectoryABI } from "./abis/avsDirectoryABI";
import { contractABI } from "./abis/contractABI";
import { delegationABI } from "./abis/delegationABI";
import { registryABI } from "./abis/registryABI";

import { Prompt, Task } from "./task";

// Load environment variables
dotenv.config();

// Connect to the Ethereum network
const provider = new ethers.providers.JsonRpcProvider(process.env.RPC_URL);

// Use the private key from the environment variable
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
  throw new Error("Private key not found in environment variables");
}
const wallet = new ethers.Wallet(privateKey, provider);

// Use the contract addresses from the environment variables
const delegationManagerAddress = process.env.DELEGATION_MANAGER_ADDRESS;
const contractAddress = process.env.CONTRACT_ADDRESS;
const stakeRegistryAddress = process.env.STAKE_REGISTRY_ADDRESS;
const avsDirectoryAddress = process.env.AVS_DIRECTORY_ADDRESS;

if (
  !delegationManagerAddress ||
  !contractAddress ||
  !stakeRegistryAddress ||
  !avsDirectoryAddress
) {
  throw new Error(
    "One or more contract addresses not found in environment variables"
  );
}

// Create contract instances
const delegationManager = new ethers.Contract(
  delegationManagerAddress,
  delegationABI,
  wallet
);
const contract = new ethers.Contract(contractAddress, contractABI, wallet);
const registryContract = new ethers.Contract(
  stakeRegistryAddress,
  registryABI,
  wallet
);
const avsDirectory = new ethers.Contract(
  avsDirectoryAddress,
  avsDirectoryABI,
  wallet
);

const MAX_RETRIES = 180; // Maximum number of retries (45 minutes with 15-second intervals)
const RETRY_INTERVAL = 10000; // 15 seconds between retries

const agent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
});

const initiateEvaluation = async (subset: string, prompts: Prompt[]) => {
  try {
    const response = await axios.post(
      `${process.env.EVALUATOR_URL}/evaluate`,
      { subset, prompts },
      {
        httpsAgent: agent,
        timeout: 30000,
      }
    );
    return response.data.task_id;
  } catch (error) {
    console.error("Error initiating evaluation:", error);
    throw error;
  }
};

const checkEvaluationStatus = async (taskId: string) => {
  try {
    const response = await axios.get(
      `${process.env.EVALUATOR_URL}/evaluate/${taskId}`,
      {
        httpsAgent: agent,
        timeout: 10000,
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error checking evaluation status:", error);
    throw error;
  }
};

const signAndRespondToTask = async (
  taskIndex: number,
  taskCreatedBlock: number,
  subset: string,
  prompts: Prompt[]
) => {
  console.log(`Initiating evaluation for subset ${subset}`);

  try {
    const taskId = await initiateEvaluation(subset, prompts);

    let result = null;
    for (let i = 0; i < MAX_RETRIES; i++) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
      const status = await checkEvaluationStatus(taskId);
      if (status.completed) {
        result = status;
        break;
      }
      console.log(
        `Evaluation in progress. Attempt ${
          i + 1
        } / ${MAX_RETRIES}. Processed: ${status.processed_prompts}/${
          status.total_prompts
        }`
      );
    }

    if (!result || !result.completed) {
      throw new Error("Evaluation timed out or failed to complete");
    }

    const accuracy = Math.floor(result.accuracy * 10000); // Convert to basis points

    console.log(`Evaluation completed. Accuracy: ${accuracy / 100}%`);

    const message = `MMLU subset: ${subset}, Accuracy: ${accuracy}`;
    const messageHash = ethers.utils.solidityKeccak256(["string"], [message]);
    const messageBytes = ethers.utils.arrayify(messageHash);
    const signature = await wallet.signMessage(messageBytes);

    console.log(`Signing and responding to task ${taskIndex}`);

    const task = {
      name: subset,
      taskCreatedBlock: taskCreatedBlock,
    };

    const tx = await contract.respondToTask(
      task,
      taskIndex,
      signature,
      accuracy
    );
    await tx.wait();
    console.log(
      `Responded to task ${taskIndex} (${subset}) with final accuracy: ${
        accuracy / 100
      }%`
    );

    // Store and log the task accuracy
    taskAccuracies[taskIndex] = accuracy / 100;
    console.log("Current task accuracies:", taskAccuracies);
    printAverageAccuracy();
  } catch (error) {
    console.error("Error in signAndRespondToTask:", error);
  }
};

const taskAccuracies: { [taskIndex: number]: number } = {};

function printAverageAccuracy() {
  const accuracies = Object.values(taskAccuracies);
  if (accuracies.length > 0) {
    const avgAccuracy =
      accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
    console.log(
      `Average accuracy across ${
        accuracies.length
      } tasks: ${avgAccuracy.toFixed(2)}%`
    );
  } else {
    console.log("No tasks completed yet");
  }
}

const registerOperator = async () => {
  console.log("Registering operator...");
  try {
    const tx1 = await delegationManager.registerAsOperator(
      {
        earningsReceiver: await wallet.address,
        delegationApprover: "0x0000000000000000000000000000000000000000",
        stakerOptOutWindowBlocks: 0,
      },
      ""
    );
    await tx1.wait();
    console.log("Operator registered on EL successfully");

    const salt = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const expiry = Math.floor(Date.now() / 1000) + 3600; // Example expiry, 1 hour from now

    // Define the output structure
    let operatorSignature = {
      expiry: expiry,
      salt: salt,
      signature: "",
    };

    // Calculate the digest hash using the avsDirectory's method
    const digestHash =
      await avsDirectory.calculateOperatorAVSRegistrationDigestHash(
        wallet.address,
        contract.address,
        salt,
        expiry
      );

    // Sign the digest hash with the operator's private key
    const signingKey = new ethers.utils.SigningKey(privateKey);
    const signature = signingKey.signDigest(digestHash);

    // Encode the signature in the required format
    operatorSignature.signature = ethers.utils.joinSignature(signature);

    const tx2 = await registryContract.registerOperatorWithSignature(
      wallet.address,
      operatorSignature
    );
    await tx2.wait();
    console.log("Operator registered on AVS successfully");
  } catch (error) {
    console.error("Error registering operator:", error);
  }
};

async function checkLatestTaskNum() {
  try {
    const latestTaskNum = await contract.latestTaskNum();
    console.log(`Latest task number: ${latestTaskNum}`);
  } catch (error) {
    console.error("Error checking latest task number:", error);
  }
}

const monitorNewTasks = async () => {
  console.log("Starting to monitor for new tasks...");
  console.log(`Listening on contract address: ${contractAddress}`);

  await checkLatestTaskNum();

  contract.on("NewTaskCreated", async (taskIndex: number, task: Task) => {
    if (taskIndex !== undefined && task) {
      console.log(
        `Task #${taskIndex} detected: subset ${task.name}, ${task.prompts.length} prompts`
      );
      await signAndRespondToTask(
        taskIndex,
        task.taskCreatedBlock,
        task.name,
        task.prompts
      );
    } else {
      console.log("New task event received, but some data is undefined:", {
        taskIndex,
        task,
      });
    }
  });

  // Add a listener for all events (for debugging)
  contract.on("*", (event: ethers.Event) => {
    console.log("Received an event:");
    console.log(event);
  });

  // Periodically check if we're still connected and check latest task number
  setInterval(async () => {
    console.log("Still listening for events...");
    console.log(`Current block number: ${await provider.getBlockNumber()}`);
    await checkLatestTaskNum();
  }, 60000); // Every minute

  // Force check for past events
  const currentBlock = await provider.getBlockNumber();
  const pastEvents = await contract.queryFilter(
    "NewTaskCreated",
    currentBlock - 1000,
    currentBlock
  );
  console.log(`Found ${pastEvents.length} past NewTaskCreated events`);
  for (const event of pastEvents) {
    if (event.args) {
      console.log(
        `Past event - Task Index: ${event.args.taskIndex}, Name: ${event.args.task.name}`
      );
    } else {
      console.log("Past event found, but args are undefined");
    }
  }
};

const main = async () => {
  try {
    await registerOperator();
    await monitorNewTasks();
  } catch (error) {
    console.error("Error in main function:", error);
  }
};

main().catch((error) => {
  console.error("Error in main function:", error);
});

// Keep the script running
process.stdin.resume();

console.log("Operator script is running. Press Ctrl+C to exit.");
