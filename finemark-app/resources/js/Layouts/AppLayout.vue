<template>
    <div class="min-h-screen bg-slate-50 text-slate-900">
        <header class="border-b border-slate-200 bg-white">
            <div class="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
                <div class="text-lg font-semibold">
                    {{ appName }}
                </div>
                <div class="text-sm text-slate-600">
                    Laravel 10 · Inertia · Vue 3
                </div>
            </div>
        </header>

        <main class="mx-auto max-w-6xl px-6 py-10">
            <slot />
        </main>
    </div>
</template>

<script setup>
defineProps({
    appName: {
        type: String,
        required: true,
    },
});
</script>
