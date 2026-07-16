<script setup>
import { computed } from 'vue';
import { Head, Link } from '@inertiajs/vue3';

const props = defineProps({
    title: {
        type: String,
        required: true,
    },
    roleLabel: {
        type: String,
        required: true,
    },
    menuItems: {
        type: Array,
        required: true,
    },
});

const items = computed(() =>
    props.menuItems.map((item) => ({
        ...item,
        isActive: item.name ? route().current(item.name) : false,
    }))
);
</script>

<template>
    <Head :title="title" />

    <div class="min-h-screen bg-slate-50 text-slate-900">
        <header class="border-b border-slate-200 bg-white">
            <div class="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
                <div>
                    <div class="text-lg font-semibold">{{ $page.props.auth.user.name }}</div>
                    <div class="text-xs uppercase tracking-wide text-slate-500">{{ roleLabel }}</div>
                </div>
                <div class="hidden text-sm text-slate-600 sm:block">
                    {{ title }}
                </div>
            </div>
        </header>

        <main class="mx-auto max-w-6xl px-6 py-10">
            <div class="grid gap-6 lg:grid-cols-[260px_1fr]">
                <aside class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                    <div class="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Modules
                    </div>
                    <nav class="space-y-2">
                        <Link
                            v-for="item in items"
                            :key="item.href"
                            :href="item.href"
                            class="flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition"
                            :class="item.isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700 hover:bg-slate-100'"
                        >
                            <span>{{ item.label }}</span>
                            <span v-if="item.badge" class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                                {{ item.badge }}
                            </span>
                        </Link>
                    </nav>
                </aside>

                <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                    <div class="mb-6">
                        <h1 class="text-2xl font-semibold text-slate-900">{{ title }}</h1>
                        <p class="mt-1 text-sm text-slate-500">
                            Welcome back, {{ $page.props.auth.user.name }}.
                        </p>
                    </div>
                    <slot />
                </section>
            </div>
        </main>
    </div>
</template>
