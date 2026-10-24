"use client"

// ============================================================
// App-styled replacements for window.confirm / window.prompt.
//
//   if (!(await confirmDialog({ title: "Delete flow?", destructive: true }))) return
//   const name = await promptDialog({ title: "Name this quick reply" })
//
// <DialogHost /> is mounted once in the root layout; the functions
// queue a request to it and resolve when the user answers (Cancel,
// Escape or clicking outside resolve as false / null).
// ============================================================

import * as React from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface BaseOptions {
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
}

export interface ConfirmOptions extends BaseOptions {
  /** Red confirm button for deletes / stops. */
  destructive?: boolean
  /** 'delete' = red "Delete" button. */
  action?: "confirm" | "delete"
}

export interface PromptOptions extends BaseOptions {
  label?: string
  placeholder?: string
  defaultValue?: string
  maxLength?: number
}

type Request =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }

let enqueue: ((req: Request) => void) | null = null

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) {
      // Host not mounted (shouldn't happen) — fall back to the browser dialog.
      resolve(typeof window !== "undefined" && window.confirm(options.title))
      return
    }
    enqueue({ kind: "confirm", options, resolve })
  })
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(typeof window !== "undefined" ? window.prompt(options.title, options.defaultValue) : null)
      return
    }
    enqueue({ kind: "prompt", options, resolve })
  })
}

export function DialogHost() {
  const t = useTranslations("Dialog")
  const [queue, setQueue] = React.useState<Request[]>([])
  const [value, setValue] = React.useState("")
  const current = queue[0] ?? null

  React.useEffect(() => {
    enqueue = (req) => setQueue((q) => [...q, req])
    return () => {
      enqueue = null
    }
  }, [])

  React.useEffect(() => {
    if (current?.kind === "prompt") setValue(current.options.defaultValue ?? "")
  }, [current])

  const answer = (ok: boolean) => {
    if (!current) return
    if (current.kind === "confirm") current.resolve(ok)
    else current.resolve(ok ? value.trim() || null : null)
    setQueue((q) => q.slice(1))
  }

  const isDelete = current?.kind === "confirm" && current.options.action === "delete"
  const destructive = current?.kind === "confirm" && (current.options.destructive || isDelete)
  const promptEmpty = current?.kind === "prompt" && !value.trim()

  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && answer(false)}>
      {current && (
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              if (!promptEmpty) answer(true)
            }}
          >
            <DialogHeader>
              <DialogTitle>{current.options.title}</DialogTitle>
              {current.options.description && (
                <DialogDescription>{current.options.description}</DialogDescription>
              )}
            </DialogHeader>
            {current.kind === "prompt" && (
              <div className="grid gap-1.5">
                {current.options.label && (
                  <label htmlFor="dialog-host-input" className="text-xs font-medium text-muted-foreground">
                    {current.options.label}
                  </label>
                )}
                <Input
                  id="dialog-host-input"
                  autoFocus
                  value={value}
                  maxLength={current.options.maxLength}
                  placeholder={current.options.placeholder}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => answer(false)}>
                {current.options.cancelLabel ?? t("cancel")}
              </Button>
              <Button
                type="submit"
                variant={destructive ? "destructive" : "default"}
                disabled={promptEmpty}
                autoFocus={current.kind === "confirm"}
              >
                {current.options.confirmLabel ??
                  (current.kind === "prompt" ? t("save") : isDelete ? t("delete") : t("confirm"))}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      )}
    </Dialog>
  )
}
