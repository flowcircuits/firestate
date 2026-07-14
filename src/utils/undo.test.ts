import { describe, it, expect, vi } from 'vitest'
import { createUndoManager } from './undo'

describe('createUndoManager', () => {
    describe('basic push/undo/redo', () => {
        it('starts with empty stacks', () => {
            const manager = createUndoManager()

            expect(manager.undoStack).toEqual([])
            expect(manager.redoStack).toEqual([])
            expect(manager.canUndo).toBe(false)
            expect(manager.canRedo).toBe(false)
        })

        it('pushes actions onto undo stack', () => {
            const manager = createUndoManager()
            const undo = vi.fn()
            const redo = vi.fn()

            manager.push({ undo, redo })

            expect(manager.undoStack.length).toBe(1)
            expect(manager.canUndo).toBe(true)
            expect(manager.canRedo).toBe(false)
        })

        it('calls undo function when undoing', async () => {
            const manager = createUndoManager()
            const undo = vi.fn()
            const redo = vi.fn()

            manager.push({ undo, redo })
            await manager.undo()

            expect(undo).toHaveBeenCalledTimes(1)
            expect(redo).not.toHaveBeenCalled()
        })

        it('moves action to redo stack after undo', async () => {
            const manager = createUndoManager()
            const undo = vi.fn()
            const redo = vi.fn()

            manager.push({ undo, redo })
            await manager.undo()

            expect(manager.undoStack.length).toBe(0)
            expect(manager.redoStack.length).toBe(1)
            expect(manager.canUndo).toBe(false)
            expect(manager.canRedo).toBe(true)
        })

        it('calls redo function when redoing', async () => {
            const manager = createUndoManager()
            const undo = vi.fn()
            const redo = vi.fn()

            manager.push({ undo, redo })
            await manager.undo()
            await manager.redo()

            expect(undo).toHaveBeenCalledTimes(1)
            expect(redo).toHaveBeenCalledTimes(1)
        })

        it('moves action back to undo stack after redo', async () => {
            const manager = createUndoManager()
            const undo = vi.fn()
            const redo = vi.fn()

            manager.push({ undo, redo })
            await manager.undo()
            await manager.redo()

            expect(manager.undoStack.length).toBe(1)
            expect(manager.redoStack.length).toBe(0)
            expect(manager.canUndo).toBe(true)
            expect(manager.canRedo).toBe(false)
        })
    })

    describe('redo stack clearing', () => {
        it('clears redo stack when new action is pushed', async () => {
            const manager = createUndoManager()

            manager.push({ undo: vi.fn(), redo: vi.fn() })
            await manager.undo()
            expect(manager.canRedo).toBe(true)

            manager.push({ undo: vi.fn(), redo: vi.fn() })
            expect(manager.canRedo).toBe(false)
            expect(manager.redoStack.length).toBe(0)
        })
    })

    describe('max length enforcement', () => {
        it('limits undo stack to maxLength', () => {
            const manager = createUndoManager({ maxLength: 3 })

            for (let i = 0; i < 5; i++) {
                manager.push({
                    undo: vi.fn(),
                    redo: vi.fn(),
                    description: `Action ${i}`,
                })
            }

            expect(manager.undoStack.length).toBe(3)
            // Oldest actions should be removed
            expect(manager.undoStack[0]?.description).toBe('Action 2')
            expect(manager.undoStack[2]?.description).toBe('Action 4')
        })

        it('enforces maxLength after redo', async () => {
            const manager = createUndoManager({ maxLength: 2 })

            manager.push({
                undo: vi.fn(),
                redo: vi.fn(),
                description: 'Action 1',
            })
            manager.push({
                undo: vi.fn(),
                redo: vi.fn(),
                description: 'Action 2',
            })

            await manager.undo()
            expect(manager.undoStack.length).toBe(1)
            expect(manager.redoStack.length).toBe(1)

            await manager.redo()
            expect(manager.undoStack.length).toBe(2)
        })
    })

    describe('action grouping', () => {
        it('merges actions with same groupId', () => {
            const manager = createUndoManager()
            const groupId = 'group-1'

            const undo1 = vi.fn()
            const redo1 = vi.fn()
            const undo2 = vi.fn()
            const redo2 = vi.fn()

            manager.push({ undo: undo1, redo: redo1, groupId })
            manager.push({ undo: undo2, redo: redo2, groupId })

            // Should have merged into single action
            expect(manager.undoStack.length).toBe(1)
        })

        it('calls both undo functions when undoing merged action', async () => {
            const manager = createUndoManager()
            const groupId = 'group-1'

            const undo1 = vi.fn()
            const undo2 = vi.fn()

            manager.push({ undo: undo1, redo: vi.fn(), groupId })
            manager.push({ undo: undo2, redo: vi.fn(), groupId })

            await manager.undo()

            // Both undo functions should be called
            expect(undo1).toHaveBeenCalledTimes(1)
            expect(undo2).toHaveBeenCalledTimes(1)
        })

        it('calls both redo functions when redoing merged action', async () => {
            const manager = createUndoManager()
            const groupId = 'group-1'

            const redo1 = vi.fn()
            const redo2 = vi.fn()

            manager.push({ undo: vi.fn(), redo: redo1, groupId })
            manager.push({ undo: vi.fn(), redo: redo2, groupId })

            await manager.undo()
            await manager.redo()

            // Both redo functions should be called
            expect(redo1).toHaveBeenCalledTimes(1)
            expect(redo2).toHaveBeenCalledTimes(1)
        })

        it('does not merge actions with different groupIds', () => {
            const manager = createUndoManager()

            manager.push({ undo: vi.fn(), redo: vi.fn(), groupId: 'group-1' })
            manager.push({ undo: vi.fn(), redo: vi.fn(), groupId: 'group-2' })

            expect(manager.undoStack.length).toBe(2)
        })

        it('does not merge actions without groupId', () => {
            const manager = createUndoManager()

            manager.push({ undo: vi.fn(), redo: vi.fn() })
            manager.push({ undo: vi.fn(), redo: vi.fn() })

            expect(manager.undoStack.length).toBe(2)
        })

        it('undo of merged group restores pre-group state when actions touch the same field', async () => {
            const manager = createUndoManager()
            const groupId = 'slider-drag'

            // Simulate three slider updates on the same value, each capturing
            // its own pre/post snapshot. Undo of the merged entry must walk
            // newest→oldest so the field ends up at its true pre-group value.
            let value = 0
            const push = (from: number, to: number) =>
                manager.push({
                    undo: () => {
                        value = from
                    },
                    redo: () => {
                        value = to
                    },
                    groupId,
                })

            push(0, 5)
            value = 5
            push(5, 10)
            value = 10
            push(10, 15)
            value = 15

            expect(manager.undoStack.length).toBe(1)

            await manager.undo()
            expect(value).toBe(0)

            await manager.redo()
            expect(value).toBe(15)
        })

        it('undoes newest-first and redoes oldest-first as one atomic group', async () => {
            const manager = createUndoManager()
            const calls: string[] = []
            const groupId = 'duct-sizer'

            for (const name of ['first', 'second', 'third']) {
                manager.push({
                    groupId,
                    undo: () => {
                        calls.push(`undo:${name}`)
                    },
                    redo: () => {
                        calls.push(`redo:${name}`)
                    },
                })
            }

            expect(manager.undoStack).toHaveLength(1)

            await manager.undo()
            expect(calls).toEqual(['undo:third', 'undo:second', 'undo:first'])
            expect(manager.undoStack).toHaveLength(0)
            expect(manager.redoStack).toHaveLength(1)

            await manager.redo()
            expect(calls).toEqual([
                'undo:third',
                'undo:second',
                'undo:first',
                'redo:first',
                'redo:second',
                'redo:third',
            ])
            expect(manager.undoStack).toHaveLength(1)
            expect(manager.redoStack).toHaveLength(0)
        })

        it('rolls back members already applied when a group member fails', async () => {
            const manager = createUndoManager()
            const calls: string[] = []
            const groupId = 'atomic-group'

            manager.push({
                groupId,
                undo: () => {
                    calls.push('undo:first')
                    throw new Error('undo failed')
                },
                redo: () => {
                    calls.push('redo:first')
                },
            })
            manager.push({
                groupId,
                undo: () => {
                    calls.push('undo:second')
                },
                redo: () => {
                    calls.push('redo:second')
                },
            })

            await expect(manager.undo()).rejects.toThrow('undo failed')
            expect(calls).toEqual(['undo:second', 'undo:first', 'redo:second'])
            expect(manager.undoStack).toHaveLength(1)
            expect(manager.redoStack).toHaveLength(0)
        })
    })

    describe('successful action callbacks', () => {
        it('calls onUndo with the action after it applies', async () => {
            const calls: string[] = []
            const onUndo = vi.fn(() => {
                calls.push('callback')
            })
            const action = {
                undo: () => {
                    calls.push('undo')
                },
                redo: vi.fn(),
                description: 'Resize duct',
            }
            const manager = createUndoManager({ onUndo })

            manager.push(action)
            await manager.undo()

            expect(calls).toEqual(['undo', 'callback'])
            expect(onUndo).toHaveBeenCalledWith(action)
        })

        it('calls onRedo with the action after it applies', async () => {
            const calls: string[] = []
            const onRedo = vi.fn(() => {
                calls.push('callback')
            })
            const action = {
                undo: vi.fn(),
                redo: () => {
                    calls.push('redo')
                },
                description: 'Resize duct',
            }
            const manager = createUndoManager({ onRedo })

            manager.push(action)
            await manager.undo()
            await manager.redo()

            expect(calls).toEqual(['redo', 'callback'])
            expect(onRedo).toHaveBeenCalledWith(action)
        })

        it('does not call successful action callbacks when applying an action fails', async () => {
            const onUndo = vi.fn()
            const onRedo = vi.fn()
            const manager = createUndoManager({ onUndo, onRedo })

            manager.push({
                undo: () => {
                    throw new Error('undo failed')
                },
                redo: () => {
                    throw new Error('redo failed')
                },
            })

            await expect(manager.undo()).rejects.toThrow('undo failed')
            expect(onUndo).not.toHaveBeenCalled()

            // Use a separate manager because the failed undo never creates a
            // redo entry.
            const redoManager = createUndoManager({ onRedo })
            redoManager.push({
                undo: vi.fn(),
                redo: () => {
                    throw new Error('redo failed')
                },
            })
            await redoManager.undo()
            await expect(redoManager.redo()).rejects.toThrow('redo failed')
            expect(onRedo).not.toHaveBeenCalled()
        })
    })

    describe('path navigation', () => {
        it('calls onNavigate with path when undoing', async () => {
            const onNavigate = vi.fn()
            const manager = createUndoManager({ onNavigate })

            manager.push({
                undo: vi.fn(),
                redo: vi.fn(),
                path: '/projects/123',
            })
            await manager.undo()

            expect(onNavigate).toHaveBeenCalledWith('/projects/123')
        })

        it('calls onNavigate with path when redoing', async () => {
            const onNavigate = vi.fn()
            const manager = createUndoManager({ onNavigate })

            manager.push({
                undo: vi.fn(),
                redo: vi.fn(),
                path: '/projects/123',
            })
            await manager.undo()
            await manager.redo()

            expect(onNavigate).toHaveBeenCalledTimes(2)
            expect(onNavigate).toHaveBeenLastCalledWith('/projects/123')
        })

        it('does not call onNavigate if no path is set', async () => {
            const onNavigate = vi.fn()
            const manager = createUndoManager({ onNavigate })

            manager.push({ undo: vi.fn(), redo: vi.fn() })
            await manager.undo()

            expect(onNavigate).not.toHaveBeenCalled()
        })
    })

    describe('clear', () => {
        it('clears both undo and redo stacks', async () => {
            const manager = createUndoManager()

            manager.push({ undo: vi.fn(), redo: vi.fn() })
            manager.push({ undo: vi.fn(), redo: vi.fn() })
            await manager.undo()

            expect(manager.undoStack.length).toBe(1)
            expect(manager.redoStack.length).toBe(1)

            manager.clear()

            expect(manager.undoStack.length).toBe(0)
            expect(manager.redoStack.length).toBe(0)
            expect(manager.canUndo).toBe(false)
            expect(manager.canRedo).toBe(false)
        })
    })

    describe('subscribe', () => {
        it('notifies subscribers when action is pushed', () => {
            const manager = createUndoManager()
            const subscriber = vi.fn()

            manager.subscribe(subscriber)
            manager.push({ undo: vi.fn(), redo: vi.fn() })

            expect(subscriber).toHaveBeenCalledWith({
                undoStack: expect.any(Array),
                redoStack: expect.any(Array),
                canUndo: true,
                canRedo: false,
            })
        })

        it('notifies subscribers after undo', async () => {
            const manager = createUndoManager()
            const subscriber = vi.fn()

            manager.push({ undo: vi.fn(), redo: vi.fn() })
            manager.subscribe(subscriber)
            await manager.undo()

            expect(subscriber).toHaveBeenCalledWith({
                undoStack: [],
                redoStack: expect.any(Array),
                canUndo: false,
                canRedo: true,
            })
        })

        it('notifies subscribers after redo', async () => {
            const manager = createUndoManager()
            const subscriber = vi.fn()

            manager.push({ undo: vi.fn(), redo: vi.fn() })
            await manager.undo()
            manager.subscribe(subscriber)
            await manager.redo()

            expect(subscriber).toHaveBeenCalledWith({
                undoStack: expect.any(Array),
                redoStack: [],
                canUndo: true,
                canRedo: false,
            })
        })

        it('notifies subscribers after clear', () => {
            const manager = createUndoManager()
            const subscriber = vi.fn()

            manager.push({ undo: vi.fn(), redo: vi.fn() })
            manager.subscribe(subscriber)
            manager.clear()

            expect(subscriber).toHaveBeenCalledWith({
                undoStack: [],
                redoStack: [],
                canUndo: false,
                canRedo: false,
            })
        })

        it('allows unsubscribing', () => {
            const manager = createUndoManager()
            const subscriber = vi.fn()

            const unsubscribe = manager.subscribe(subscriber)
            unsubscribe()

            manager.push({ undo: vi.fn(), redo: vi.fn() })

            expect(subscriber).not.toHaveBeenCalled()
        })
    })

    describe('error handling', () => {
        it('reports failed actions through onError', async () => {
            const onError = vi.fn()
            const error = new Error('Undo failed')
            const action = {
                undo: vi.fn().mockRejectedValue(error),
                redo: vi.fn(),
            }
            const manager = createUndoManager({ onError })

            manager.push(action)

            await expect(manager.undo()).rejects.toThrow('Undo failed')
            expect(onError).toHaveBeenCalledWith(error, action, 'undo')
        })

        it('restores action to undo stack if undo fails', async () => {
            const manager = createUndoManager()
            const error = new Error('Undo failed')
            const undo = vi.fn().mockRejectedValue(error)

            manager.push({ undo, redo: vi.fn() })

            await expect(manager.undo()).rejects.toThrow('Undo failed')
            expect(manager.undoStack.length).toBe(1)
            expect(manager.redoStack.length).toBe(0)
        })

        it('restores action to redo stack if redo fails', async () => {
            const manager = createUndoManager()
            const error = new Error('Redo failed')
            const redo = vi.fn().mockRejectedValue(error)

            manager.push({ undo: vi.fn(), redo })
            await manager.undo()

            await expect(manager.redo()).rejects.toThrow('Redo failed')
            expect(manager.undoStack.length).toBe(0)
            expect(manager.redoStack.length).toBe(1)
        })
    })

    describe('async actions', () => {
        it('supports async undo functions', async () => {
            const manager = createUndoManager()
            let value = 'new'

            const undo = async () => {
                await new Promise((resolve) => setTimeout(resolve, 10))
                value = 'old'
            }

            manager.push({ undo, redo: vi.fn() })
            await manager.undo()

            expect(value).toBe('old')
        })

        it('supports async redo functions', async () => {
            const manager = createUndoManager()
            let value = 'old'

            const redo = async () => {
                await new Promise((resolve) => setTimeout(resolve, 10))
                value = 'new'
            }

            manager.push({ undo: vi.fn(), redo })
            await manager.undo()
            await manager.redo()

            expect(value).toBe('new')
        })
    })
})
