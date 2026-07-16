<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';

const menuItems = [
    { label: 'User Management', href: '#' },
    { label: 'Roles & Permissions', href: '#' },
    { label: 'System Settings', href: '#' },
    { label: 'Audit Logs', href: '#' },
];
</script>

<template>
    <DashboardLayout title="Super Admin Dashboard" role-label="Super Admin" :menu-items="menuItems">
        <h1 class="text-2xl font-semibold">Super Admin Dashboard</h1>
        <p class="mt-2 text-sm text-slate-600">
            Administer users, configure systems, and monitor audit trails.
        </p>
    </DashboardLayout>
</template>
