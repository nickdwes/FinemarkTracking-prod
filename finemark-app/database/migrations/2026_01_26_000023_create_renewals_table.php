<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('renewals', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('customer_id')->constrained('customers')->cascadeOnDelete();
            $table->foreignUuid('vehicle_id')->nullable()->constrained('vehicles')->nullOnDelete();
            $table->foreignUuid('certificate_id')->nullable()->constrained('certificates')->nullOnDelete();
            $table->string('status')->default('pending')->index();
            $table->date('starts_at')->nullable();
            $table->date('ends_at')->nullable();
            $table->boolean('auto_renew')->default(false);
            $table->string('renewal_type')->default('annual');
            $table->decimal('price', 12, 2)->default(0);
            $table->jsonb('metadata')->nullable();
            $table->timestamps();

            $table->index(['customer_id', 'vehicle_id', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('renewals');
    }
};
