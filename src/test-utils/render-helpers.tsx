import React from 'react'
import { render, renderHook, type RenderHookOptions } from '@testing-library/react'
import { FirestateProvider, type FirestateProviderProps } from '../provider'
import { mockFirestore } from './firestore-mock'

type ProviderOverrides = Partial<Omit<FirestateProviderProps, 'firestore' | 'children'>>

/**
 * Render any component tree wrapped in a FirestateProvider that uses the
 * Firestore mock. Pass `provider` overrides to tweak autosave, maxUndoLength,
 * onError, etc.
 */
export const renderWithProvider = (
    ui: React.ReactElement,
    options: { provider?: ProviderOverrides } = {}
): ReturnType<typeof render> => {
    const { provider = {} } = options
    return render(ui, {
        wrapper: ({ children }) => (
            <FirestateProvider firestore={mockFirestore.firestore} {...provider}>
                {children}
            </FirestateProvider>
        ),
    })
}

/**
 * renderHook variant that wraps in FirestateProvider. The hook can read/use
 * any Firestate hook (useDocument, useCollection, etc.) and the underlying
 * Firestore calls hit the mock.
 */
export const renderHookWithProvider = <Result, Props>(
    callback: (props: Props) => Result,
    options: RenderHookOptions<Props> & { provider?: ProviderOverrides } = {}
) => {
    const { provider = {}, wrapper: outerWrapper, ...rest } = options as RenderHookOptions<Props> & {
        provider?: ProviderOverrides
    }

    const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
        const wrapped = (
            <FirestateProvider firestore={mockFirestore.firestore} {...provider}>
                {children}
            </FirestateProvider>
        )
        if (outerWrapper) {
            const Outer = outerWrapper as React.ComponentType<{ children: React.ReactNode }>
            return <Outer>{wrapped}</Outer>
        }
        return wrapped
    }

    return renderHook(callback, { ...rest, wrapper: Wrapper })
}
