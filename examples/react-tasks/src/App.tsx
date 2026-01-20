import { useState } from 'react'
import {
  FirestateProvider,
  useDocument,
  useCollection,
  useUndoManager,
  useUndoKeyboardShortcuts,
  useIsSynced,
} from '@flowcircuits/firestate'
import { db } from './firebase'
import { taskListDoc, tasksCollection, type Task } from './schemas'

// Hardcoded list ID for demo - in a real app this would come from routing
const LIST_ID = 'demo-list'

function TaskListEditor() {
  const params = { listId: LIST_ID }

  // Subscribe to the task list document
  const taskList = useDocument({ definition: taskListDoc, params })

  // Subscribe to the tasks collection
  const tasks = useCollection({ definition: tasksCollection, params })

  // Undo/redo functionality
  const { undo, redo, canUndo, canRedo } = useUndoManager()

  // Enable Ctrl/Cmd+Z and Ctrl/Cmd+Y keyboard shortcuts
  useUndoKeyboardShortcuts()

  // Global sync status
  const isSynced = useIsSynced()

  // Local state for new task input
  const [newTaskTitle, setNewTaskTitle] = useState('')

  // Create the task list if it doesn't exist
  const createTaskList = () => {
    taskList.set({
      name: 'My Tasks',
      description: 'A demo task list',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }

  // Add a new task
  const addTask = () => {
    if (!newTaskTitle.trim()) return

    const taskId = `task-${Date.now()}`
    tasks.add(taskId, {
      title: newTaskTitle.trim(),
      completed: false,
      priority: 'medium',
      createdAt: Date.now(),
    })
    setNewTaskTitle('')
  }

  // Toggle task completion
  const toggleTask = (taskId: string, completed: boolean) => {
    tasks.update({ [taskId]: { completed: !completed } })
  }

  // Update task priority
  const updatePriority = (taskId: string, priority: Task['priority']) => {
    tasks.update({ [taskId]: { priority } })
  }

  // Delete a task
  const deleteTask = (taskId: string) => {
    tasks.remove(taskId)
  }

  // Loading state
  if (taskList.isLoading) {
    return <div style={styles.loading}>Loading...</div>
  }

  // Task list doesn't exist yet
  if (!taskList.data) {
    return (
      <div style={styles.container}>
        <h1>Firestate Tasks Example</h1>
        <p>No task list found. Create one to get started.</p>
        <button onClick={createTaskList} style={styles.button}>
          Create Task List
        </button>
      </div>
    )
  }

  const taskArray = Object.entries(tasks.data).map(([id, task]) => ({
    id,
    ...task,
  }))

  return (
    <div style={styles.container}>
      {/* Header with sync indicator */}
      <header style={styles.header}>
        <div>
          <input
            type="text"
            value={taskList.data.name}
            onChange={(e) =>
              taskList.update({ name: e.target.value, updatedAt: Date.now() })
            }
            style={styles.titleInput}
          />
          <div style={styles.syncStatus}>
            {isSynced ? (
              <span style={styles.synced}>All changes saved</span>
            ) : (
              <span style={styles.syncing}>Saving...</span>
            )}
          </div>
        </div>

        {/* Undo/Redo buttons */}
        <div style={styles.undoButtons}>
          <button
            onClick={undo}
            disabled={!canUndo}
            style={styles.undoButton}
            title="Undo (Ctrl/Cmd+Z)"
          >
            Undo
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            style={styles.undoButton}
            title="Redo (Ctrl/Cmd+Y)"
          >
            Redo
          </button>
        </div>
      </header>

      {/* Add task form */}
      <div style={styles.addForm}>
        <input
          type="text"
          placeholder="Add a new task..."
          value={newTaskTitle}
          onChange={(e) => setNewTaskTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTask()}
          style={styles.input}
        />
        <button onClick={addTask} style={styles.button}>
          Add
        </button>
      </div>

      {/* Task list */}
      {tasks.isLoading ? (
        <div style={styles.loading}>Loading tasks...</div>
      ) : taskArray.length === 0 ? (
        <p style={styles.empty}>No tasks yet. Add one above!</p>
      ) : (
        <ul style={styles.taskList}>
          {taskArray
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((task) => (
              <li key={task.id} style={styles.taskItem}>
                <input
                  type="checkbox"
                  checked={task.completed}
                  onChange={() => toggleTask(task.id, task.completed)}
                  style={styles.checkbox}
                />
                <span
                  style={{
                    ...styles.taskTitle,
                    textDecoration: task.completed ? 'line-through' : 'none',
                    opacity: task.completed ? 0.6 : 1,
                  }}
                >
                  {task.title}
                </span>
                <select
                  value={task.priority}
                  onChange={(e) =>
                    updatePriority(task.id, e.target.value as Task['priority'])
                  }
                  style={{
                    ...styles.prioritySelect,
                    backgroundColor: priorityColors[task.priority],
                  }}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
                <button
                  onClick={() => deleteTask(task.id)}
                  style={styles.deleteButton}
                >
                  Delete
                </button>
              </li>
            ))}
        </ul>
      )}

      {/* Footer with tips */}
      <footer style={styles.footer}>
        <p>
          <strong>Tips:</strong> Try editing the list name, adding tasks,
          toggling completion, or changing priorities. Use{' '}
          <kbd>Ctrl/Cmd+Z</kbd> to undo and <kbd>Ctrl/Cmd+Y</kbd> to redo.
        </p>
        <p>
          Open this page in multiple tabs to see real-time sync in action!
        </p>
      </footer>
    </div>
  )
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
      <TaskListEditor />
    </FirestateProvider>
  )
}

// Priority colors
const priorityColors = {
  low: '#e8f5e9',
  medium: '#fff3e0',
  high: '#ffebee',
}

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
  syncStatus: {
    fontSize: 12,
    marginTop: 4,
  },
  synced: {
    color: '#4caf50',
  },
  syncing: {
    color: '#ff9800',
  },
  undoButtons: {
    display: 'flex',
    gap: 8,
    flexShrink: 0,
  },
  undoButton: {
    padding: '6px 12px',
    fontSize: 12,
    border: '1px solid #ddd',
    borderRadius: 4,
    background: 'white',
    cursor: 'pointer',
  },
  addForm: {
    display: 'flex',
    gap: 8,
    marginBottom: 20,
  },
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
  loading: {
    textAlign: 'center',
    padding: 40,
    color: '#666',
  },
  empty: {
    textAlign: 'center',
    color: '#999',
    padding: 20,
  },
  taskList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  taskItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 0',
    borderBottom: '1px solid #eee',
  },
  checkbox: {
    width: 18,
    height: 18,
    cursor: 'pointer',
  },
  taskTitle: {
    flex: 1,
    fontSize: 14,
  },
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
