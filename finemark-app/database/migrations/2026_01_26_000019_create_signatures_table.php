<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('signatures', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->uuidMorphs('signable');
            $table->foreignUuid('signed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('signature_type')->default('digital');
            $table->text('signature_data');
            $table->timestamp('signed_at')->useCurrent();
            $table->string('ip_address')->nullable();
            $table->text('user_agent')->nullable();
            $table->jsonb('metadata')->nullable();
            $table->timestamps();

            $table->index('signed_by');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('signatures');
    }
};
