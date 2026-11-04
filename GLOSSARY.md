# AI Playground

A desktop app that runs chat, agent and media-generation models locally on Intel GPUs, organised
around the presets a user picks.

## Sessions

**Session**:
The unit of work the user sees in the sessions panel: one continuous history in which any mix of
presets can take turns. A new Session starts only when the user asks for one.
_Avoid_: user session, agent session, conversation, thread

**Title**:
What a Session is called in the sessions panel: its Name if it has one, otherwise its first prompt,
shortened.

**Name**:
A Title the user gave a Session explicitly. It changes what the Session is called, not where it is
listed.
_Avoid_: rename (as a noun), label

**Session Group**:
A named group of Sessions the user creates, listed in the sessions panel and expanded to show its
Sessions. A Session is in at most one Session Group; deleting a Session Group keeps its Sessions.
_Avoid_: folder, project, collection, category

**Pinned Session**:
A Session the user keeps at the top of the sessions panel, above Session Groups and recent ones,
until unpinned. Pinning does not take a Session out of its Session Group.
_Avoid_: favourite, starred

**Harness Session**:
The agent harness's own conversation inside a Session, one per Agent Preset used there; it carries
that preset's full context across its turns.
_Avoid_: Pi session, agent session

**Session History**:
The append-only record of everything that happened in a Session, in order — which preset ran, what
it was asked, and what it produced.
_Avoid_: transcript, log

**History Entry**:
One turn's record in the Session History.

**Session Folder**:
The directory that belongs to one Session, where the artifacts its turns produce are kept.
_Avoid_: media folder, output folder

**Artifact**:
A file a turn produced — an image, video, 3D model or audio clip — kept in its Session's Session
Folder.
_Avoid_: media item, output, generation

**Session Update**:
A short templated digest of the History Entries a chat preset or Agent Preset missed since its own
last turn in the Session, handed to it with the next prompt. Never a model-written summary.
_Avoid_: session summary, recap

## Agents

**Agent**:
A named, repeatable piece of work that belongs to one Session: an ordered list of Steps run with
its own Settings Template, by hand or on a Schedule.
_Avoid_: Task, job, automation

**Agent Preset**:
A chat preset that runs on the agent harness — Agent Maker, Game Agent, Quick Coder, or an Agent
saved as a preset.
_Avoid_: agent (on its own, for a preset)

**Step**:
One prompt of an Agent, sent as its own turn.

**Settings Template**:
The settings an Agent's runs use, fixed on the Agent rather than taken from the Session.

**Schedule**:
The recurring interval at which an Agent runs by itself.

**Agent Run**:
One execution of an Agent's Steps inside its Session, in a fresh Harness Session that starts with
no context from the Session.
_Avoid_: Task Run, Task Session, scheduled session

## Settings

**Session Settings**:
A preset's settings as they apply within one Session; changing them affects no other Session.

**Default Settings**:
A preset's saved settings, copied into a Session the first time that preset is used there.
_Avoid_: preset settings, global settings

**Machine Settings**:
Settings that apply to every Session on this machine at once — device, backend install, speech
engine and voice, developer toggles. Changing one changes it for every Session.
_Avoid_: global settings, app settings
