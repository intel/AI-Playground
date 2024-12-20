# AI Playground arc42 documentation

## Introduction and Goals

Intel AI-Playground is a standalone application that enables users with Intel graphics cards to interact with generative
AI via a graphical user interface on their PC. It allows model inference to be executed directly on Intel-specific
hardware, eliminating the need for external setup steps. The application supports popular generative AI functionalities,
including image generation and conversational AI.

### Requirements Overview

- **Generative AI with Intel Graphics Cards**  
  The AI Playground enables model inference specifically on Intel devices. Users can interact with chat models, image
  generation, and image modification models, all via configurable generation pipelines ("workflows"). Different models
  may be selected.
- **Self-contained Inference Environments**  
  AI Playground automatically handles the installation of required models, the inference environment, and other
  dependencies necessary for execution, ensuring a seamless experience for users. Various inference libraries are
  offered to the user, most of them fully optional and only installed on explicit approval by the user.
- **Dynamic Workflow Updates**  
  Users can fetch new workflows published by Intel directly from within AI Playground. These updates are provided
  without requiring new installations or releases, allowing users to stay up to date with the latest offerings.

### Quality Goals

TBD

## Context and Scope

![](AI-PG_ContextView.svg)

| Node                     | Description                                                                                                                                                                               | 
|--------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| GitHub                   | Github repositories hosting 3rd party extensions. Additional Extensions are cloned and set up on behalf of the user                                                                       |
| AI Playground Repository | Github repositories of AI Playground. Additional workflows are released by intel and pushed to this repository. The application may update their workflow definitions by the intel source |
| Model Repositories       | The models used for inference need to be downloaded from external sources, e.g. huggingface.com                                                                                           |

## Building Block View

![](AI-PG_ComponentView.svg)

For the Application with its GUI, an electron App is used. This decomposes into the electron main process and the
window, displayed to the user. All user interaction is being done via this window. The window is running technically from
within a browser and the GUI is handled using Vue.js. As it runs from within a browser, this component has further
restrictions, that limit overall what it can do on its own. Most notable restrictions are: no direct interaction with
the filesystem or spawning of subprocesses. Such responsibilities are then mostly solved from within the main process.
The window and main process component of the electron app thus need the inter-process communication of electron.

For AI model inference, we use or support popular Python libraries such as PyTorch or ComfyUI. These Python environments
may need to be set up carefully and may need to patched for specific Intel hardware. Where this is required, an Intel
maintained "serviceDirectory" containing the Python project is maintained from within this source code. Other inference
libraries may be fully loaded from external sources such as GitHub and PyPI.

To transmit the data - both user input prompts from the window as well as model inference responses - inference
libraries are wrapped in webservices. Their API may then be called from the window. The webservices are controlled as
long living subprocesses below the main process. From perspective of the main process, these webservices follow the
interface of an "apiService", which especially specifies the set up steps needed to perform a full installation.

## Risk and Technical Debt

### Technical Debt

<table>
<thead>
    <th>Debt</th>
    <th>Description</th>
    <th>Impact</th>
</thead>
  <tr>
    <!--- Default AI Playground backend is not only performing inference --->
    <td>Default AI Playground backend is required for other inference backends</td>
    <td>
        The default inference backend historically has been the only backend and has been used to perform both: model 
        inference as well as huggingface repository interactions. When additional inference backends had been introduced and
        generalized, this was not corrected.<br>
        As other inference backends also rely on the downloading of models, the other services depend on the default backend.
    </td>
    <td>
        The different backends are all actively relying on the default backend being available to perform model downloading.
        This is a considerable constraint, as we try to restart/stop unused inference backend in order to safe resources
        graphic cards.
    </td>
  </tr>
  <!--- Workflow definitions are not fully descriptive on their own --->
  <tr>
    <td>Workflow definitions are not fully descriptive on their own</td>
    <td>
        AI Playground offers pre-configured workflows for image generating AI. For ComfyUI workflows, an approach was 
        chosen to make the workflow definition contain all relevant pieces of data. For the workflows in the default 
        Backend, important information may only be computed at later stages in the code, as this is the case for the 
        model terms URL.
    </td>
    <td>
        Publishing of workflows post release is heavily restricted. For ComfyUI flows, a broader range of workflows may
        be published without further assumptions. For default workflows, one may only rely on models already known to AI
        Playground.
    </td>
  </tr>
<!--- Current Inference Backend Abstraction is missing --->
  <tr>
    <td>"Current Inference" Abstraction is missing</td>
    <td>
        AI Playground support multiple backends to be chosen. Generation depends heavily on the selected backend. There
        is no abstraction or proxy around the current inference backend. The different tabs in the application instead 
        rely on ifs and string identifiers to select the backend themselves and at different places
    </td>
    <td>
        Code is more convoluted than needed, seemingly simple changes are not safe from side effects or suddenly expensive to
        implement. This was increasingly notable during en- and disabling of certain inference features in order to safe
        computational resources.
    </td>
  </tr>
</table>
