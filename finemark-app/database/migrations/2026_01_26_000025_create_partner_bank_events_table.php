<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('partner_bank_events', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('customer_id')->nullable()->constrained('customers')->nullOnDelete();
            $table->foreignUuid('vehicle_id')->nullable()->constrained('vehicles')->nullOnDelete();
            $table->string('bank_name')->index();
            $table->string('event_type')->index();
            $table->string('status')->default('received')->index();
            $table->string('reference')->nullable()->index();
            $table->jsonb('payload');
            $table->timestamp('received_at')->useCurrent();
            $table->timestamp('processed_at')->nullable();
            $table->timestamps();

            $table->index(['customer_id', 'vehicle_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('partner_bank_events');
    }
};
