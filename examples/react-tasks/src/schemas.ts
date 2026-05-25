import { defineDocument, defineCollection } from "@hvakr/firestate";

// Shape of a task list (document)
export interface TaskList {
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

// Shape of an individual task (collection document)
export interface Task {
  title: string;
  completed: boolean;
  priority: "low" | "medium" | "high";
  createdAt: number;
}

// Define the task list document
export const taskListDoc = defineDocument<TaskList>({
  collection: "taskLists",
  id: (params: Record<string, string>) => params.listId,
  autosave: 500,
});

// Define the tasks collection (subcollection of a task list)
export const tasksCollection = defineCollection<Task>({
  path: (params: Record<string, string>) => `taskLists/${params.listId}/tasks`,
  autosave: 500,
});
