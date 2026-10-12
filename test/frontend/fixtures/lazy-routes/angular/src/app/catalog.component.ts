import { Component, OnInit, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";

@Component({ selector: "app-catalog", standalone: true, template: "<p>catalog</p>" })
export class CatalogComponent implements OnInit {
  private readonly http = inject(HttpClient);
  ngOnInit() {
    this.http.get("/api/catalog").subscribe();
  }
}
