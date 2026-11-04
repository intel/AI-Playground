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
A Title the user gave a Session explicitly. A Session with a Name is listed under Named.
_Avoid_: rename (as a noun), label

**Pinned Session**:
A Session the user keeps at the top of the sessions panel, above Named and recent ones, until
unpinned.
_Avoid_: favourite, starred

**Harness Session**:
The agent harness's own conversation inside a Session, one per agent preset used there; it carries
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

**Session Update**:
A short templated digest of the History Entries a chat or agent preset missed since its own last
turn in the Session, handed to it with the next prompt. Never a model-written summary.
_Avoid_: session summary, recap

## Tasks

**Task**:
A named, repeatable piece of agent work that belongs to one Session: an ordered list of Steps run
with its own Settings Template, by hand or on a Schedule.
_Avoid_: job, automation

**Step**:
One prompt of a Task, sent as its own turn.

**Settings Template**:
The settings a Task's runs use, fixed on the Task rather than taken from the Session.

**Schedule**:
The recurring interval at which a Task runs by itself.

**Task Run**:
One execution of a Task's Steps inside its Session, in a fresh Harness Session that starts with no
context from the Session.
_Avoid_: Task Session, scheduled session

## Settings

**Session Settings**:
A preset's settings as they apply within one Session; changing them affects no other Session.

**Default Settings**:
A preset's saved settings, copied into a Session the first time that preset is used there.
_Avoid_: preset settings, global settings
