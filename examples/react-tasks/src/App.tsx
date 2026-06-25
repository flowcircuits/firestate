import { memo, useState } from 'react'
import {
    FirestateProvider,
    useUndoManager,
    useUndoKeyboardShortcuts,
    useIsSynced,
} from '@hvakr/firestate'
import { db } from './firebase'
// Hooks come from their resource module, not one central registry — the list's
// slices live in `firestore/taskList.ts`, the collection's in `firestore/tasks.ts`.
import { useListName, useListGate } from './firestore/taskList'
import { useTasks, useTaskListView, useTaskById, Task } from './firestore/tasks'

// Hardcoded list ID for the demo — in a real app this would come from routing.
// Defined at module scope so the params object identity is STABLE across
// renders. That matters: `memo`'d children would otherwise see a fresh params
// object every parent render and re-render anyway.
const LIST_ID = 'demo-list'
const PARAMS = { listId: LIST_ID }

// --- Why this file is split the way it is -----------------------------------
//
// A single component that reads the whole list + collection re-renders wholesale
// on every keystroke, toggle, and sync flip. Instead, each piece below
// subscribes to the narrowest slice it needs, via a NAMED slice-hook defined
// next to the schema in its resource module (`firestore/taskList.ts`,
// `firestore/tasks.ts` — `useListName`, `useTaskById`, ...):
//
//   - A slice-hook gates re-renders driven by the STORE (a sibling's change
//     won't touch you if your slice is value-equal).
//   - `memo` gates re-renders driven by the PARENT (so when the list container
//     re-renders on add/delete, existing rows don't re-render too).
//
// Minimal re-renders needs BOTH. The result: editing one task re-renders only
// that row; renaming the list re-renders only the title; toggling sync state
// re-renders only the sync badge. (The add form's write-only handle is the one
// trivial one-off left inline, as `useTasks(..., { selector: () => null })`.)
// ----------------------------------------------------------------------------

/** List title. Subscribes to just `name` — re-renders only when the name changes. */
function TitleEditor() {
    const list = useListName(PARAMS)
    return (
        <input
            type='text'
            value={list.data ?? ''}
            onChange={(e) =>
                list.update({ name: e.target.value, updatedAt: Date.now() })
            }
            style={styles.titleInput}
        />
    )
}

/** Global "all saved?" indicator — re-renders only when sync state flips. */
function SyncStatus() {
    const isSynced = useIsSynced()
    return (
        <div style={styles.syncStatus}>
            {isSynced ? (
                <span style={styles.synced}>All changes saved</span>
            ) : (
                <span style={styles.syncing}>Saving...</span>
            )}
        </div>
    )
}

/** Undo/redo buttons — re-renders only when undo availability changes. */
function UndoRedo() {
    const { undo, redo, canUndo, canRedo } = useUndoManager()
    return (
        <div style={styles.undoButtons}>
            <button
                onClick={undo}
                disabled={!canUndo}
                style={styles.undoButton}
                title='Undo (Ctrl/Cmd+Z)'
            >
                Undo
            </button>
            <button
                onClick={redo}
                disabled={!canRedo}
                style={styles.undoButton}
                title='Redo (Ctrl/Cmd+Y)'
            >
                Redo
            </button>
        </div>
    )
}

/**
 * Add-task form. Owns its own input state and a write-only handle: the constant
 * selector keeps its slice value-equal forever, so task data changes never
 * re-render the form — only its own keystrokes do.
 */
function AddTaskForm() {
    const [title, setTitle] = useState('')
    const tasks = useTasks(PARAMS, { selector: () => null })

    const addTask = () => {
        const trimmed = title.trim()
        if (!trimmed) return
        tasks.add(`task-${Date.now()}`, {
            title: trimmed,
            completed: false,
            priority: 'medium',
            createdAt: Date.now(),
        })
        setTitle('')
    }

    return (
        <div style={styles.addForm}>
            <input
                type='text'
                placeholder='Add a new task...'
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTask()}
                style={styles.input}
            />
            <button onClick={addTask} style={styles.button}>
                Add
            </button>
        </div>
    )
}

/**
 * A single row, subscribed to its OWN task slice via `useTaskById`. The id is
 * part of the merged params bag (`{ listId, id }`), so the row asks for exactly
 * its task. Re-renders only when this task changes (store-driven); `memo` stops
 * the list container from re-rendering it on add/delete. All rows still share
 * one collection listener — the slice differs per row, the subscription doesn't.
 */
const TaskRow = memo(function TaskRow({ id }: { id: string }) {
    const task = useTaskById({ ...PARAMS, id })
    const data = task.data
    if (!data) return null

    return (
        <li style={styles.taskItem}>
            <input
                type='checkbox'
                checked={data.completed}
                onChange={() =>
                    task.update({ [id]: { completed: !data.completed } })
                }
                style={styles.checkbox}
            />
            <span
                style={{
                    ...styles.taskTitle,
                    textDecoration: data.completed ? 'line-through' : 'none',
                    opacity: data.completed ? 0.6 : 1,
                }}
            >
                {data.title}
            </span>
            <select
                value={data.priority}
                onChange={(e) =>
                    task.update({
                        [id]: { priority: e.target.value as Task['priority'] },
                    })
                }
                style={{
                    ...styles.prioritySelect,
                    backgroundColor: priorityColors[data.priority],
                }}
            >
                <option value='low'>Low</option>
                <option value='medium'>Medium</option>
                <option value='high'>High</option>
            </select>
            <button onClick={() => task.remove(id)} style={styles.deleteButton}>
                Delete
            </button>
        </li>
    )
})

/**
 * The list container. Its `taskListView` slice is a loading flag plus the
 * ORDERED set of task ids. `createdAt` is immutable, so the id array is
 * value-equal across field edits — this re-renders only when a task is added or
 * removed (or the load flag flips). Each row fetches its own data. Status isn't
 * free under the pure selector API, so `loading` is part of the slice.
 */
function TaskListBody() {
    const tasks = useTaskListView(PARAMS)

    if (tasks.data.loading) {
        return <div style={styles.loading}>Loading tasks...</div>
    }
    if (tasks.data.ids.length === 0) {
        return <p style={styles.empty}>No tasks yet. Add one above!</p>
    }
    return (
        <ul style={styles.taskList}>
            {tasks.data.ids.map((id) => (
                <TaskRow key={id} id={id} />
            ))}
        </ul>
    )
}

/** Attaches Ctrl/Cmd+Z / +Y shortcuts. Isolated so undo-state churn here can't
 *  re-render the editor shell. */
function UndoKeyboardShortcuts() {
    useUndoKeyboardShortcuts()
    return null
}

/**
 * Pure layout. Subscribes to nothing, so it never re-renders after mount — each
 * piece below owns its own subscription and updates independently.
 */
function EditorShell() {
    return (
        <div style={styles.container}>
            <UndoKeyboardShortcuts />
            <header style={styles.header}>
                <div>
                    <TitleEditor />
                    <SyncStatus />
                </div>
                <UndoRedo />
            </header>

            <AddTaskForm />
            <TaskListBody />

            <footer style={styles.footer}>
                <p>
                    <strong>Tips:</strong> Try editing the list name, adding
                    tasks, toggling completion, or changing priorities. Use{' '}
                    <kbd>Ctrl/Cmd+Z</kbd> to undo and <kbd>Ctrl/Cmd+Y</kbd> to
                    redo.
                </p>
                <p>
                    Open this page in multiple tabs to see real-time sync in
                    action!
                </p>
            </footer>
        </div>
    )
}

/**
 * Decides between loading / create-list / editor. Subscribes only to the list's
 * EXISTENCE, so editing the name or tasks never re-renders this gate.
 */
function TaskListGate() {
    const list = useListGate(PARAMS)

    if (list.data.loading) {
        return <div style={styles.loading}>Loading...</div>
    }

    if (!list.data.exists) {
        return (
            <div style={styles.container}>
                <h1>Firestate Tasks Example</h1>
                <p>No task list found. Create one to get started.</p>
                <button
                    onClick={() =>
                        list.set({
                            name: 'My Tasks',
                            description: 'A demo task list',
                            createdAt: Date.now(),
                            updatedAt: Date.now(),
                        })
                    }
                    style={styles.button}
                >
                    Create Task List
                </button>
            </div>
        )
    }

    return <EditorShell />
}

export default function App() {
    return (
        <FirestateProvider
            firestore={db}
            autosave={500}
            maxUndoLength={50}
            onError={(error, context) => {
                console.error('Firestate error:', context.path, error)
            }}
        >
            <TaskListGate />
        </FirestateProvider>
    )
}

// Priority colors
const priorityColors = { low: '#e8f5e9', medium: '#fff3e0', high: '#ffebee' }

// Inline styles for simplicity
const styles: Record<string, React.CSSProperties> = {
    container: {
        background: 'white',
        borderRadius: 8,
        padding: 24,
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
    },
    header: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 20,
        gap: 16,
    },
    titleInput: {
        fontSize: 24,
        fontWeight: 'bold',
        border: 'none',
        borderBottom: '2px solid transparent',
        padding: '4px 0',
        width: '100%',
        outline: 'none',
        background: 'transparent',
    },
    syncStatus: { fontSize: 12, marginTop: 4 },
    synced: { color: '#4caf50' },
    syncing: { color: '#ff9800' },
    undoButtons: { display: 'flex', gap: 8, flexShrink: 0 },
    undoButton: {
        padding: '6px 12px',
        fontSize: 12,
        border: '1px solid #ddd',
        borderRadius: 4,
        background: 'white',
        cursor: 'pointer',
    },
    addForm: { display: 'flex', gap: 8, marginBottom: 20 },
    input: {
        flex: 1,
        padding: '10px 12px',
        fontSize: 14,
        border: '1px solid #ddd',
        borderRadius: 4,
        outline: 'none',
    },
    button: {
        padding: '10px 16px',
        fontSize: 14,
        border: 'none',
        borderRadius: 4,
        background: '#2196f3',
        color: 'white',
        cursor: 'pointer',
    },
    loading: { textAlign: 'center', padding: 40, color: '#666' },
    empty: { textAlign: 'center', color: '#999', padding: 20 },
    taskList: { listStyle: 'none', padding: 0, margin: 0 },
    taskItem: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 0',
        borderBottom: '1px solid #eee',
    },
    checkbox: { width: 18, height: 18, cursor: 'pointer' },
    taskTitle: { flex: 1, fontSize: 14 },
    prioritySelect: {
        padding: '4px 8px',
        fontSize: 12,
        border: '1px solid #ddd',
        borderRadius: 4,
        cursor: 'pointer',
    },
    deleteButton: {
        padding: '4px 8px',
        fontSize: 12,
        border: 'none',
        borderRadius: 4,
        background: '#f44336',
        color: 'white',
        cursor: 'pointer',
    },
    footer: {
        marginTop: 24,
        paddingTop: 16,
        borderTop: '1px solid #eee',
        fontSize: 12,
        color: '#666',
    },
}
