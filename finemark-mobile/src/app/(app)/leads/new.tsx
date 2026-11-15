import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { RetailLeadForm } from '@/features/sales/RetailLeadForm';
import { CorporateLeadForm } from '@/features/sales/CorporateLeadForm';

export default function NewLead() {
  const { type } = useLocalSearchParams<{ type: string }>();
  return type === 'corporate' ? <CorporateLeadForm /> : <RetailLeadForm />;
}
