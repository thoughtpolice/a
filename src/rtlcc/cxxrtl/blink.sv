// SPDX-FileCopyrightText: © 2024-2025 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

module blink
   #( parameter int LED_BIT = 7
    , parameter int COUNTER_WIDTH = 12
    )
    ( input logic clk
    , output logic led
    );

  logic [COUNTER_WIDTH-1:0] counter = 'h0;

  always_ff @(posedge clk) begin
      counter <= counter + 1'b1;
  end

  assign led = counter[LED_BIT];
endmodule
