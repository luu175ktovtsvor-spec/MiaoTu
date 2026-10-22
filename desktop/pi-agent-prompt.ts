import { join } from 'node:path'

type PromptTool = { name: string; promptSnippet?: string; promptGuidelines?: string[] }
type ComputerAccess = { enabled: boolean; directory: string }
type PromptRequest = { tools: PromptTool[]; customPrompt?: string; addendum: string }

// Use the installed SDK's builder and project-context loader. Both module paths
// are verified against the pinned SDK before changing the desktop integration.
const sdkEntry = import.meta.resolve('@earendil-works/pi-coding-agent')
const sdk = Promise.all([
  import(new URL('./core/system-prompt.js', sdkEntry).href),
  import(new URL('./core/resource-loader.js', sdkEntry).href),
])

export function createPiAgentPrompt({ directory, status }: { directory: string; status: () => ComputerAccess }) {
  return async ({ tools, customPrompt, addendum }: PromptRequest): Promise<string> => {
    const [{ buildSystemPrompt }, { loadProjectContextFiles }] = await sdk
    const access = status()
    return buildSystemPrompt({
      cwd: access.directory,
      selectedTools: tools.map(tool => tool.name),
      toolSnippets: Object.fromEntries(tools.filter(tool => tool.promptSnippet).map(tool => [tool.name, tool.promptSnippet])),
      toolGuidelines: Object.fromEntries(tools.filter(tool => tool.promptGuidelines?.length).map(tool => [tool.name, tool.promptGuidelines])),
      contextFiles: access.enabled ? loadProjectContextFiles({ cwd: access.directory, agentDir: join(directory, 'agent-runtime') }) : [],
      customPrompt,
      appendSystemPrompt: addendum,
    })
  }
}
