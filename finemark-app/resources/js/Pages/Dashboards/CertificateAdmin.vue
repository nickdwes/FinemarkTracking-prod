<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';

const menuItems = [
    { label: 'Issuance Queue', href: '#' },
    { label: 'Certificates', href: '#' },
    { label: 'Templates', href: '#' },
    { label: 'Verification', href: '#' },
];
</script>

<template>
    <DashboardLayout
        title="Certificate Admin Dashboard"
        role-label="Certificate Admin"
        :menu-items="menuItems"
    >
        <h1 class="text-2xl font-semibold">Certificate Admin Dashboard</h1>
        <p class="mt-2 text-sm text-slate-600">
            Issue, manage, and verify certificates with the latest templates.
        </p>
    </DashboardLayout>
</template>
