## Brainiac notes

"Brainiac" is an Model Context Protocol tool designed to expose monorepo-specific functionality, behavior, and informationto agents like Claude Code, allowing them to better navigate and interact with the monorepo effectively.
```
claude mcp add "brainiac" buck2 run depot//src/tools/brainiac
```
Brainiac needs to always work for a wide array of use cases, while remaining reasonably secure and powerful.

You MUST ALWAYS run all of the tests on all changes to this code: `depot//src/tools/brainiac`
You MUST ALWAYS run the linter on all changes: `buck2 test depot//src/tools/brainiac[lint]`
