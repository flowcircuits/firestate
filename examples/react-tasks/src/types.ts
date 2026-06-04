import type { StandardSchemaV1 } from '@hvakr/firestate'

// Plain TypeScript interfaces are the source of truth for our document
// shapes here. Firestate's registry API requires a Standard Schema
// validator per entry, but it never invokes it — the schema only exists
// so firestate can infer the data type for the generated hooks. The
// tiny `typeSchema<T>()` helper below builds the minimum Standard Schema
// object that satisfies the contract.
//
// In production, swap any of these for a real validator (anything that
// implements Standard Schema — see https://standardschema.dev) and you
// also get runtime validation to call at your own boundaries.

export interface TaskList {
    name: string
    description?: string
    createdAt: number
    updatedAt: number
}

export interface Task {
    title: string
    completed: boolean
    priority: 'low' | 'medium' | 'high'
    createdAt: number
}

// No-op Standard Schema validator — carries `T` for inference, doesn't
// validate. Real apps usually replace this with a Standard-Schema-compatible
// validator library of their choice.
function typeSchema<T>(): StandardSchemaV1<unknown, T> {
    return {
        '~standard': {
            version: 1,
            vendor: 'react-tasks-example',
            validate: (value) => ({ value: value as T }),
            types: undefined,
        },
    }
}

export const TaskListSchema = typeSchema<TaskList>()
export const TaskSchema = typeSchema<Task>()
