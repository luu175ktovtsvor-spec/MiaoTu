import * as three from 'three'
import { runAgentLoop } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

// The plug-in contract stays complete and shares the same module instances.
// This module contains no account credentials or canvas state.
export function installNodeExtraHost() {
  Object.assign(window.miaoimgNodeHost!, { three, ai: { runAgentLoop, createAssistantMessageEventStream } })
}
