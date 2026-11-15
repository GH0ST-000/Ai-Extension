
# Working Rules

1. Work autonomously on assigned tasks.
2. Do not ask for confirmation before every step.
3. Do not ask "Should I continue?" after completing intermediate steps.
4. Continue until the requested task is fully completed.
5. Make reasonable technical decisions independently.
6. Run tests and fix errors when possible.
7. Ask questions only when critical information is missing.
8. Do not stop after planning. Implement the solution.
9. Provide a summary only after completing the task.
## Shell Command Rules

Avoid shell commands that use dynamically resolved file paths.

Do not use shell variables to construct paths for file reading.

Prefer direct file paths and simple commands that can be statically inspected.

Do not use node -e or node -p for file path resolution when a direct path is available.