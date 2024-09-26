<template>
    <div id="learn-more" class="pt-10 text-white flex flex-col items-center gap-7 text-base">
        <div>
            <h1 class="text-center font-bold text-lg">Tune In!</h1>
            <p class="text-center pt-3">Get access to content, expertise and our growing community to learn more
                about
                running AI on Intel PC</p>
        </div>
        <div class="flex items-center gap-6">
            <img src="/Intel_Insiders.png" class="flex-none" />
            <div class="flex flex-col justify-center gap-4  flex-grow">
                <h2 class="font-bold text-lg">Join Intel Insiders Discord</h2>
                <p>Connect with Intel and our growing community of PC and GenAI enthusiast.</p>
                <p>Join The Conversation [<a href="http://discord.gg/intel" 
                        class="">http://discord.gg/intel</a>]</p>
                <a class="view-btn" href="http://discord.gg/intel" >
                    <span>View</span>
                    <span class="svg-icon i-arrow-right w-5 h-5"></span>
                </a>
            </div>
        </div>
        <div class="flex items-center gap-6 flex-row-reverse">
            <img src="/TechCraftVideos.png" class="flex-none" />
            <div class="flex flex-col justify-center gap-4 flex-grow">
                <h2 class=" font-bold text-lg">Tech Craft Videos</h2>
                <p>Get access to tips and techniques for GenAI on Intel</p>
                <p>JHardware with our TechCraft Video Series</p>
                <a href="https://www.youtube.com/@IntelTechnology" >Watch Here:
                    [https://www.youtube.com/@IntelTechnology]</a>
                <a class="view-btn" href="https://www.youtube.com/@IntelTechnology" >
                    <span>View</span>
                    <span class="svg-icon i-arrow-right w-5 h-5"></span>
                </a>
            </div>
        </div>
        <div>
            <h1 class="font-bold text-lg text-center">Up Your GenAI Game！</h1>
            <p class="pt-4">Ready to graduate from AI Playground? Check these solutions out. Be aware, many require
                setting up a dev environment to install and run. Connect with our community on Discord for guidance
            </p>
            <div class="ai-games pt-4 w-full grid grid-cols-2 gap-5">
                <div>
                    <div class="flex flex-col justify-between">
                        <div>
                            <img src="/Fooocus.png" />
                            <h2 class="font-bold text-lg pt-3">Fooocus Web UI</h2>
                            <p class="pt-2">Want to face swap, add refiners, and stylize your images but keep the
                                experience
                                super easy. Try
                                Fooocus. Join our Discord to get installation instructions and tips on using this tool.
                            </p>
                        </div>
                        <a href="https://github.com/lllyasviel/Fooocus" 
                            class="flex gap-1 items-center "><span class="">Learn more</span><span
                                class="svg-icon i-arrow-right w-4 h-4"></span></a>
                    </div>
                </div>
                <div>
                    <div class="flex flex-col justify-between">
                        <div>
                            <img src="/ComfyUI.png" />
                            <h2 class="font-bold text-lg pt-3">Comfy UI</h2>
                            <p class="pt-2">Want ultimate control, features for image generation than AI Playground can
                                offer.  Then try ComfyUI.   Join our Discord to get installation instructions and tips
                                on
                                using this tool.
                            </p>
                        </div>
                        <a href="https://github.com/comfyanonymous/ComfyUI" 
                            class="flex gap-1 items-center "><span class="">Learn more</span><span
                                class="svg-icon i-arrow-right w-4 h-4"></span></a>
                    </div>
                </div>
                <div>
                    <div class="flex flex-col justify-between">
                        <div>
                            <img src="/A1111.png" />
                            <h2 class="font-bold text-lg pt-3">A1111 Stable Diffusion WebUI</h2>
                            <p class="pt-2">Want the best performance with your Intel Arc GPU and have with deep
                                features like ControlNet, while using the most popular webui for image generation.
                            </p>
                        </div>
                        <a href="https://github.com/AUTOMATIC1111/stable-diffusion-webui" 
                            class="flex gap-1 items-center "><span class="">Learn more</span><span
                                class="svg-icon i-arrow-right w-4 h-4"></span></a>
                    </div>
                </div>
                <div>
                    <div class="flex flex-col justify-between">
                        <div>
                            <img src="/SDNext.png" />
                            <h2 class="font-bold text-lg pt-3">SDNext WebUI</h2>
                            <p class="pt-2">Taking the A1111 interface to the next level with a strong community of
                                enthusiast supporting Intel Arc, IPEX and OpenVINO
                            </p>
                        </div>
                        <a href="https://github.com/vladmandic/automatic" 
                            class="flex gap-1 items-center "><span class="">Learn more</span><span
                                class="svg-icon i-arrow-right w-4 h-4"></span></a>
                    </div>
                </div>
            </div>
        </div>
        <div class="flex flex-col pb-10">
            <h1 class="font-bold text-lg text-center">Fork This!</h1>
            <img src="/AI_Playground.png" class="pt-4 flex-none" />
            <h2 class="font-bold text-lg pt-6">AI Playground GitHub</h2>
            <p class="pt-4">Get access to AI Playground code to learn from, experiment and build upon this starter
                app. {link to be
                determined near launch}</p>
            <div class="pt-3 flex justify-center">
                <a href="https://github.com/intel/ai-playground" 
                    class="flex gap-1 items-center"><span class="">Learn more</span><span
                        class="svg-icon i-arrow-right w-4 h-4"></span></a>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">

onMounted(() => {
    document.getElementById("learn-more")!.querySelectorAll("a").forEach((item) => {
        item.addEventListener("click", function (e) {
            e.preventDefault();
            window.electronAPI.openUrl(this.href as string);
            return false;
        })
    })
})

</script>