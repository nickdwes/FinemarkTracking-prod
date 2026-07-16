<script setup>
import DashboardLayout from '@/Layouts/DashboardLayout.vue';

const menuItems = [
    { label: 'Leads', href: '#' },
    { label: 'Quotes', href: '#' },
    { label: 'Customers', href: '#' },
    { label: 'Invoices', href: '#' },
];
</script>

<template>
    <DashboardLayout title="Sales Dashboard" role-label="Sales" :menu-items="menuItems">
        <h1 class="text-2xl font-semibold">Sales Dashboard</h1>
        <p class="mt-2 text-sm text-slate-600">
            Track pipeline, manage customers, and monitor revenue performance.
        </p>
    </DashboardLayout>
</template>
