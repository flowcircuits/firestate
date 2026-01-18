# Firestate React Tasks Example

A simple task manager demonstrating Firestate's key features in a React application.

## Features Demonstrated

- **Document subscription** - Task list name syncs in real-time
- **Collection subscription** - Tasks are automatically synced
- **Undo/Redo** - Full undo/redo support with keyboard shortcuts
- **Sync indicators** - Visual feedback for save status
- **CRUD operations** - Add, update, and delete tasks
- **Optimistic updates** - Changes appear immediately

## Setup

### 1. Create a Firebase Project

1. Go to the [Firebase Console](https://console.firebase.google.com/)
2. Create a new project (or use an existing one)
3. Enable Cloud Firestore:
   - Navigate to Build > Firestore Database
   - Click "Create database"
   - Start in test mode for development

### 2. Get Your Firebase Config

1. In Firebase Console, go to Project Settings (gear icon)
2. Scroll down to "Your apps"
3. Click "Add app" and select Web (</>)
4. Register your app and copy the config object

### 3. Update Firebase Config

Edit `src/firebase.ts` and replace the placeholder config with your values:

```typescript
const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'your-project.firebaseapp.com',
  projectId: 'your-project',
  storageBucket: 'your-project.appspot.com',
  messagingSenderId: '123456789',
  appId: '1:123456789:web:abcdef123456',
}
```

### 4. Install Dependencies and Run

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev
```

The app will be available at `http://localhost:5173`.

## Usage

1. **Create a task list** - Click the button to create your first task list
2. **Edit the title** - Click on the list name to edit it
3. **Add tasks** - Type in the input and press Enter or click Add
4. **Toggle completion** - Click the checkbox
5. **Change priority** - Use the dropdown to set Low/Medium/High
6. **Delete tasks** - Click the Delete button
7. **Undo/Redo** - Use the buttons or `Ctrl/Cmd+Z` and `Ctrl/Cmd+Y`

## Real-time Sync

Open the app in multiple browser tabs to see real-time synchronization in action. Changes made in one tab will appear instantly in others.

## Project Structure

```
src/
├── firebase.ts    # Firebase initialization
├── schemas.ts     # Firestate schema definitions
├── App.tsx        # Main React component
└── main.tsx       # React entry point
```

## Key Concepts

### Schema Definitions

```typescript
// Define your data shape with Zod
const TaskSchema = z.object({
  title: z.string(),
  completed: z.boolean(),
  priority: z.enum(['low', 'medium', 'high']),
  createdAt: z.number(),
})

// Create a collection definition
const tasksCollection = defineCollection({
  schema: TaskSchema,
  path: (params) => `taskLists/${params.listId}/tasks`,
  autosave: 500,
})
```

### Using in Components

```typescript
// Subscribe to the collection
const tasks = useCollection({ definition: tasksCollection, params })

// Update a task
tasks.update({ [taskId]: { completed: true } })

// Add a new task
tasks.add('new-id', { title: 'New Task', completed: false, ... })

// Remove a task
tasks.remove(taskId)
```

### Undo/Redo

```typescript
const { undo, redo, canUndo, canRedo } = useUndoManager()

// Enable keyboard shortcuts
useUndoKeyboardShortcuts()
```

## Learn More

- [Firestate Documentation](../../README.md)
- [Firebase Documentation](https://firebase.google.com/docs)
- [Zod Documentation](https://zod.dev/)
