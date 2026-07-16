<template>
    <AppLayout :app-name="appName">
        <div class="space-y-6">
            <div class="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
                <h1 class="text-3xl font-semibold">Welcome to {{ appName }}</h1>
                <p class="mt-2 text-slate-600">
                    Your Laravel 10 + Inertia.js + Vue 3 starter is ready.
                </p>
            </div>

            <div class="grid gap-4 md:grid-cols-3">
                <div class="rounded-lg border border-slate-200 bg-white p-5">
                    <h2 class="text-lg font-semibold">Postgres</h2>
                    <p class="mt-1 text-sm text-slate-600">Configured via .env</p>
                </div>
                <div class="rounded-lg border border-slate-200 bg-white p-5">
                    <h2 class="text-lg font-semibold">Redis</h2>
                    <p class="mt-1 text-sm text-slate-600">Cache + queue ready</p>
                </div>
                <div class="rounded-lg border border-slate-200 bg-white p-5">
                    <h2 class="text-lg font-semibold">S3</h2>
                    <p class="mt-1 text-sm text-slate-600">Compatible storage config</p>
                </div>
            </div>
        </div>
    </AppLayout>
</template>

<script setup>
import AppLayout from '@/Layouts/AppLayout.vue';

defineProps({
    appName: {
        type: String,
        required: true,
    },
});
</script>
