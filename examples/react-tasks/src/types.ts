// Shape of a task list (document)
export interface TaskList {
    name: string
    description?: string
    createdAt: number
    updatedAt: number
}

// Shape of an individual task (collection document)
export interface Task {
    title: string
    completed: boolean
    priority: 'low' | 'medium' | 'high'
    createdAt: number
}
