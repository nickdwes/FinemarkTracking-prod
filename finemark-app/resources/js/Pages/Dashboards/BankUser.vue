<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';

const menuItems = [
    { label: 'Finance Requests', href: '#' },
    { label: 'Statements', href: '#' },
    { label: 'Compliance', href: '#' },
    { label: 'Releases', href: '#' },
];
</script>

<template>
    <DashboardLayout title="Bank User Dashboard" role-label="Bank User" :menu-items="menuItems">
        <h1 class="text-2xl font-semibold">Bank User Dashboard</h1>
        <p class="mt-2 text-sm text-slate-600">
            Review financing requests, statements, and compliance checks.
        </p>
    </DashboardLayout>
</template>
