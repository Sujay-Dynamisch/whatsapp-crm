# Claude Code — Low Token Usage & Efficient Editing Rules

## Core Objective

Optimize every task for **minimum token usage** while maintaining correctness.

Do NOT read, analyze, summarize, or modify parts of the codebase that are unrelated to the requested task.

---

## 1. Read Only What Is Necessary

- Never scan the entire repository unless explicitly requested.
- Do not recursively read all files.
- Start by identifying the **smallest number of files** required for the task.
- Read only the relevant functions, components, hooks, services, types, configuration, or styles.
- If the relevant file is already known, open that file directly.
- Do not inspect unrelated modules "for context" unless absolutely necessary.
- Prefer targeted searches using exact function names, component names, variable names, routes, IDs, or error messages.

### Rule:
**Search → identify relevant file → read minimal section → edit.**

Do NOT:
**scan repository → understand everything → then edit.**

---

## 2. Do Not Explain the Codebase

Do not provide:
- repository summaries
- architecture explanations
- file-by-file explanations
- unnecessary reasoning
- long descriptions of what you found
- repeated explanations of existing code

Only provide a short summary of:
1. What changed
2. Which files changed
3. Any important issue/blocker

Keep the final response concise.

---

## 3. Make Minimal Changes

When modifying code:

- Change only what is required.
- Do not refactor unrelated code.
- Do not rename variables/components unless required.
- Do not reorganize files unless required.
- Do not change formatting of untouched code.
- Do not rewrite an entire file when a small patch is sufficient.
- Preserve existing architecture and patterns.
- Reuse existing utilities/components/functions whenever possible.

### Preferred:

```text
Small targeted patch
```

### Avoid:

```text
Rewrite entire component/file
```

---

## 4. Inspect Before Editing

Before making changes:

1. Search for the relevant implementation.
2. Read only the necessary code.
3. Determine the smallest safe modification.
4. Apply the patch.

Do not repeatedly reread the same file unless the file has changed or additional context is genuinely required.

---

## 5. Use Targeted Search

Prefer searches like:

```bash
rg "ComponentName"
rg "functionName"
rg "error message"
rg "routeName"
rg "API_ENDPOINT"
```

Instead of broad repository exploration.

When possible, search exact identifiers first.

---

## 6. Avoid Unnecessary Tool Calls

Every tool call should have a clear purpose.

Do NOT:

- inspect files without a reason
- run unnecessary commands
- repeatedly check the same file
- repeatedly run the same tests
- inspect git history unless required
- inspect dependencies unless the task involves them
- inspect generated/build folders
- inspect `node_modules`
- inspect `.git`
- inspect caches
- inspect binaries

Ignore these unless specifically required:

```text
node_modules/
.git/
dist/
build/
.gradle/
Pods/
DerivedData/
coverage/
.cache/
.next/
.expo/
```

---

## 7. Testing

Run the **smallest relevant test/check**.

For a UI component change:
- Prefer targeted lint/typecheck if available.
- Do not run the entire test suite unless necessary.

For a single backend function:
- Test that function/route if a targeted test exists.
- Do not run unrelated tests.

For a TypeScript change:
- Prefer targeted type checking when possible.

Only run expensive commands when the change justifies them.

---

## 8. Don't Fix Unrelated Issues

If you discover unrelated errors:

- Do NOT fix them automatically.
- Do NOT refactor them.
- Do NOT modify unrelated files.

Mention them briefly only if they block the requested task.

---

## 9. Preserve Existing Patterns

Before introducing something new:

- Search for an existing implementation.
- Reuse existing components/utilities/hooks/services/types.
- Follow the project's current conventions.

Do not introduce a new library or dependency unless explicitly requested or absolutely necessary.

---

## 10. Dependencies

Never install a package automatically unless:

- the user explicitly requested it, or
- the requested feature genuinely cannot be implemented without it.

Before installing a dependency, check whether the functionality already exists in the project.

---

## 11. Git

Do not run expensive git commands unnecessarily.

Do not inspect full git history.

After editing, if useful, use:

```bash
git diff --stat
git diff -- <changed-file>
```

Only inspect the diff for files actually modified.

Never modify commits, reset branches, or perform destructive git operations unless explicitly requested.

---

## 12. File Editing

Prefer targeted edits/patches.

If only 5 lines need to change, change only those 5 lines.

Do not regenerate the entire file.

Do not change whitespace or formatting outside the edited section.

---

## 13. User Requirements Have Priority

Treat the user's request as the source of truth.

If the requested change is clear:

**Do it directly.**

Do not ask unnecessary confirmation questions.

Only ask a question when continuing without clarification could cause a significant incorrect implementation.

---

## 14. Context Management

Keep the working context small.

When a task is localized:

```text
1. Find relevant file
2. Read relevant section
3. Edit
4. Run minimal validation
5. Stop
```

Do not accumulate unnecessary context.

Do not read previous implementation history unless required.

Do not repeatedly summarize previous work.

---

## 15. Avoid Duplicate Work

Before editing:

- Check whether the requested functionality already exists.
- Search before creating new files/functions/components.
- Do not create duplicate utilities or components.

If something already exists, modify/reuse it.

---

## 16. UI Changes

For UI changes:

- Find the exact screen/component first.
- Read only that component and directly related styles/hooks.
- Reuse existing design system components.
- Do not inspect unrelated screens.
- Do not redesign surrounding UI unless requested.
- Do not modify global styles unless required.

---

## 17. API / Backend Changes

For backend changes:

- Locate the exact route/controller/service.
- Inspect only the related model/schema if needed.
- Inspect existing API patterns before creating new ones.
- Do not read the entire backend architecture.
- Do not refactor unrelated endpoints.

---

## 18. React / React Native Changes

For React or React Native:

- Locate the exact screen/component.
- Check only directly related hooks, API calls, types, and navigation.
- Reuse existing components.
- Do not inspect the complete navigation tree unless navigation is involved.
- Do not inspect all screens.

---

## 19. Error Fixes

For an error:

1. Search the exact error.
2. Locate the source.
3. Inspect the smallest relevant code path.
4. Fix the root cause.
5. Run the smallest validation necessary.

Do not perform a broad codebase audit unless explicitly requested.

---

## 20. Final Response

Keep the final response extremely short.

Use this format:

```text
Implemented.

Changed:
- file1.tsx — fixed X
- file2.ts — updated Y

Validation:
- Passed / Not run

Notes:
- Only mention important blockers or remaining issues.
```

Do not include lengthy explanations unless explicitly requested.

---

# STRICT TOKEN-SAVING RULE

Before every tool call, ask:

> "Is this information necessary to complete the user's request?"

If the answer is **no**, do not make the tool call.

Prefer:

**1 search → 1 read → 1 edit → 1 validation**

over multiple exploratory operations.

When the task is complete, **STOP**.

Do not continue exploring the repository after the requested change has been successfully implemented.