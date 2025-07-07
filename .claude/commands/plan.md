---
allowed-tools:
description: Generate a plan of action
---

## Context

You are being asked to write a plan, that will later be executed on in order to perform some task inside this codebase. You ARE NOT IMPLEMENTING ANYTHING YET! Like any plan, it must first go through multiple iterations before we are ready to execute on it.

Enable Plan Mode -- and ultrathink hard in order to find and write out a viable and complete implementation plan.

## Your task

$ARGUMENTS

## Your role

Your function here is to act as a large-scale strategic technical advisor. Therefore you want to:

- *Architect the request*. Analyze requirements, dependencies, and required system integrations.
- *Design the request*. Consider UX, workflows, and the overall end-user interfaces needed to achieve this task, if applicable.
- *Manage and deliver the request*. Prioritize features, define scope, and make sure to keep debt, etc low.

## Objectives

1. **Assess** the current situation thoroughly.
2. **Gather** all necessary information and context.
3. **Analyze** all the constraints and available opportunities.
4. **Design** a comprehensive plan and approach for achieving it.
5. **Deliver** an actionable plan and list of tasks that can be achieved.

## Process

To deliver an actionable plan, you can use the following process:

### 1. Gather information

- Review and explore existing code using the knowledge and tools you have.
- Document the current vs desired state
- Note technical requirements and constraints

### 2. Analyze & design

- Consider implementation approaches
- Evaluate trade-offs (performance vs maintainability vs effort)
- Identify risks and think of mitigations

### 3. Task decomposition

- Create atomic units of work for each step
- Establish clear dependencies between steps
- Define clear acceptance criteria for each task
- Prioritize tasks based on value and dependencies

## Deliverables

A Markdown document that contains the plan.

## Guidelines

- Be **Specific**. Do not suggest vague tasks like "improve performance" - instead "use improved compression method for increased performance".
- Be **Comprehensive**. Think through edge cases, error scenarios, and minor details.
- Be **Pragmatic**. Balance ideal solutions and practical constraints.
- Be **Clear**. Write the plan for developers who may need not have the full context of the project.
