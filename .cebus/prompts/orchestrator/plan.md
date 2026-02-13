# Orchestrator Plan Generation

When the analyzer determines a task is complex, use these rules to generate a multi-round plan.

## Task Decomposition Rules

1. **Identify the goal**: What is the end state the user wants?
2. **Break into steps**: Each step should be a single agent action.
3. **Assign agents**: Match each step to the best agent by role.
4. **Order steps**: Identify dependencies — what must happen before what.
5. **Estimate cost**: How many rounds and how expensive.

## Agent Assignment Heuristics

- **Implementation steps** → Developer/Engineer agents
- **Review steps** → Reviewer/QA/Security agents
- **Design steps** → Architect/Designer agents
- **Planning steps** → Product Manager/Task Planner agents
- **Testing steps** → QA/Engineer agents

## Agent Capabilities (CRITICAL)

Each agent has a capability tag in their description:
- `[can execute: file editing, shell commands]` — Can implement, create files, run commands
- `[chat only]` — Can only discuss, advise, review (conceptually)

**NEVER assign implementation steps to `[chat only]` agents.** Only `[can execute]` agents can appear in steps that involve writing code, creating files, or running commands. `[chat only]` agents can appear in deliberation (brainstorm, propose, critique), conceptual review, and synthesis steps.

If no `[can execute]` agents exist, plans MUST be discussion-only (no implementation steps).

## Common Patterns

### Deliberation Pattern (Default for creative/build tasks with 2+ agents)

Use this when the task involves CREATING something and multiple agents with different expertise are available. Agents discuss before implementing.

1. Agent A: Propose approach — opinions, architecture, trade-offs (NO implementation)
2. Agent B: Review proposal, add perspective — critique, alternatives (NO implementation)
3. Agent A: Synthesize both approaches into unified plan
4. Agent A: Implement the agreed design
5. Agent B: Review implementation

### Code Change Pattern (For modifications to existing code)
1. Developer: Implement changes
2. Reviewer: Review implementation
3. Developer: Apply feedback (if needed)

### Feature Design Pattern
1. Architect: Design approach
2. Developer: Implement
3. QA: Review and test

### Bug Fix Pattern (Skip deliberation)
1. Developer: Investigate and fix
2. Reviewer: Verify fix is correct

## When to Use Deliberation vs. Direct Execution

**Use Deliberation Pattern when:**
- Building new features, components, or systems
- Architecture or design decisions with trade-offs
- Multiple agents have relevant but different expertise
- The task benefits from diverse perspectives before implementation

**Skip Deliberation (direct execution) when:**
- Bug fixes with clear causes
- Single-agent tasks
- User has provided detailed specifications (they already decided the approach)
- Simple factual or informational requests

## Cost Estimation Rules

- **low**: 1-2 agents, 1-2 rounds, simple task
- **medium**: 2-3 agents, 2-4 rounds, moderate complexity
- **high**: 3+ agents, 4+ rounds, complex multi-step task (includes deliberation)

## Plan Format

```json
{
  "description": "Clear summary of what the plan will accomplish",
  "steps": [
    { "agentId": "engineer", "action": "Propose approach (NO code)" },
    { "agentId": "architect", "action": "Review proposal, add perspective (NO code)", "dependsOn": 0 },
    { "agentId": "engineer", "action": "Synthesize into unified plan", "dependsOn": 1 },
    { "agentId": "engineer", "action": "Implement the agreed design", "dependsOn": 2 },
    { "agentId": "architect", "action": "Review implementation", "dependsOn": 3 }
  ],
  "estimatedRounds": 5,
  "estimatedCost": "high"
}
```
