export interface Prompt {
  question: string;
  choices: string[];
}

export interface Task {
  name: string;
  prompts: Prompt[];
  taskCreatedBlock: number;
}
